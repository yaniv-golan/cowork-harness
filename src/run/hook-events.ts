/**
 * Mount-time warning for a plugin that declares a hook event this harness does not serve.
 *
 * WHY THIS EXISTS. The harness installs `PreToolUse` only (see `SERVED_HOOK_EVENTS`), while real Cowork
 * installs three event types and the agent binary accepts thirty-three. Before this check, a plugin
 * declaring `UserPromptSubmit` mounted, ran, and produced no comment of any kind — a consumer had to
 * grep the harness's own compiled output to discover the surface was unmodelled. That is the failure
 * this closes: not "the hook doesn't work", but "nothing told you the harness has no opinion about it".
 *
 * WHY IT IS ALSO HERE AND NOT ONLY IN `lint-skill`. The static linter is opt-in and many scenarios never
 * run it. A run that mounts the plugin is the one moment we know the declaration exists AND that someone
 * is about to depend on it, so the warning belongs on that path too.
 *
 * WHAT IT SAYS, AND WHY THAT WORDING. A plugin's own hooks DO fire here — live-verified 2026-08-01 at
 * BOTH `container` and `hostloop` with a fixture plugin declaring SessionStart / UserPromptSubmit /
 * PostToolUse: all three executed. The agent binary loads them through the `--plugin-dir` channel, which
 * the harness neither serves nor blocks. So this notice must NOT say "your hook won't run" — that would
 * be false and would send an author rewriting working code.
 *
 * BUT THAT RECEIPT COVERS THREE EVENTS, NOT THIRTY-THREE. `KNOWN_HOOK_EVENTS` grew from 9 to 33 on
 * 2026-09-06 when it was re-sourced from the agent's own validator array. "The validator accepts this
 * name" is not "a harness run reaches this trigger": nothing has shown that a run ever raises
 * `WorktreeCreate`, `TeammateIdle`, `TaskCreated`, `ConfigChange` or `DirectoryAdded`. So the message
 * splits — `LIVE_VERIFIED_PLUGIN_HOOK_EVENTS` keeps the measured "WILL fire", everything else gets
 * "is a real event … whether a run reaches its trigger has not been verified here". Widening the
 * confident wording means running the case, not editing the sentence.
 *
 * What is actually missing is about the HARNESS, not the plugin: it does not install the additional hooks
 * real Cowork installs for that event (so their effects are absent). Gating on the plugin's own hook is
 * covered — `hook_event_fired` / `hook_event_blocked` read the agent's hook_response frames, which the
 * spawn turns on (`--include-hook-events`) exactly when a staged plugin declares hooks.
 *
 * PLACEMENT MATTERS AND IS SILENT. The binary reads `<plugin>/hooks/hooks.json`. The identical file at
 * the plugin ROOT fires nothing, with no error anywhere — which is exactly how a probe (and a consumer)
 * can conclude "hooks don't work in Cowork" from a misplaced file. Flagged separately.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { KNOWN_HOOK_EVENTS, LIVE_VERIFIED_PLUGIN_HOOK_EVENTS, SERVED_HOOK_EVENTS, type HookEvent } from "../agent/session.js";

/** Depth-limited `hooks.json` search. A plugin root holds them at the root or one level down
 *  (`skills/<name>/hooks.json`, `.claude-plugin/hooks.json`); walking deeper would wander into
 *  `node_modules`-shaped trees for no gain. */
function findHooksFiles(root: string, depth = 2): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, d: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir is not a lint failure — the mount itself will report a real problem
    }
    for (const e of entries) {
      const p = join(dir, e);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (d > 0 && e !== "node_modules" && !e.startsWith(".git")) walk(p, d - 1);
      } else if (e === "hooks.json") out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

/** Event names declared by a `hooks.json`, tolerating both the `{"hooks": {...}}` (settings.json) shape
 *  and a bare `{...}` event map. Returns [] for anything unparseable — a malformed hooks.json is the
 *  static linter's problem, not this warning's. */
export function declaredHookEvents(hooksJsonPath: string): string[] {
  try {
    const doc = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
    if (!doc || typeof doc !== "object") return [];
    const events = doc.hooks && typeof doc.hooks === "object" ? doc.hooks : doc;
    if (!events || typeof events !== "object") return [];
    return Object.keys(events).filter((k) => typeof k === "string");
  } catch {
    return [];
  }
}

/** Emit one `::warning::` per (source, unserved event). Never throws — a warning path that can fail the
 *  run would be worse than the silence it replaces. */
export function warnUnservedHookEvents(pluginRoots: string[], warn: (msg: string) => void): void {
  const served = new Set<string>(SERVED_HOOK_EVENTS);
  const known = new Set<string>(KNOWN_HOOK_EVENTS as readonly string[]);
  const firesHere = new Set<string>(LIVE_VERIFIED_PLUGIN_HOOK_EVENTS);
  const seen = new Set<string>(); // dedupe: the same event across N mounted plugins warns once per source
  for (const root of pluginRoots) {
    for (const f of findHooksFiles(root)) {
      // Placement check, before the per-event loop: a root-level `hooks.json` fires NOTHING, so the
      // events it declares are moot and reporting them would bury the real problem.
      if (!f.endsWith(`${sep}hooks${sep}hooks.json`)) {
        warn(
          `::warning:: [hooks] ${f} is not under a \`hooks/\` directory — the agent reads plugin hooks from ` +
            `\`<plugin>/hooks/hooks.json\`, so this file is silently ignored and NONE of its hooks run. Move it.\n`,
        );
        continue;
      }
      for (const name of declaredHookEvents(f)) {
        if (served.has(name)) continue;
        const key = `${f}::${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warn(
          known.has(name as HookEvent)
            ? `::notice:: [hooks] ${f} declares \`${name}\` — ${
                firesHere.has(name)
                  ? "it WILL fire (a plugin's own hooks are executed by the agent)"
                  : "the agent accepts it as a real event and loads a plugin's own hooks itself (whether a " +
                    "harness run ever reaches this event's trigger has not been verified here)"
              }. This harness installs only ${[...SERVED_HOOK_EVENTS].join(", ")} itself: ` +
                `\`hook_event_fired: ${name}\` / \`hook_event_blocked: ${name}\` (and \`hook_output_*\` for what it printed) grade it from the agent's own ` +
                `hook_response frames (the harness passes --include-hook-events because this plugin declares ` +
                `hooks), and if real Cowork installs a \`${name}\` hook of its own it is not reproduced here ` +
                `(it installs hooks for PreToolUse, PostToolUse and UserPromptSubmit only). Assert the hook's ` +
                `observable effect as well.\n`
            : `::warning:: [hooks] ${f} declares \`${name}\`, which is not a hook event the agent recognizes — it is ` +
                `ignored everywhere, so this hook never runs. Check spelling/capitalization.\n`,
        );
      }
    }
  }
}

/** Hook events a plugin MANIFEST declares. Both spellings the repo accepts elsewhere
 *  (`isPluginManifestDir`): `<plugin>/.claude-plugin/plugin.json`, else a bare `<plugin>/plugin.json`.
 *
 *  This is a SECOND, independent channel from `hooks/hooks.json`, and it is the more common spelling in
 *  the wild. Missing it made the `protocol` consent gate defeatable by a spelling choice: a plugin
 *  declaring `SessionStart` here ran its hook as a native host process while the gate stayed silent and
 *  no disclosure printed (reproduced end-to-end, sentinel written under the operator's own account).
 *
 *  Deliberately NOT subject to the `hooks/hooks.json` placement carve-out below: a misplaced root-level
 *  `hooks.json` is inert, so gating on it would refuse a run over a file that cannot execute — but a
 *  manifest-declared hook is LIVE. Inertness is the reason for that carve-out, and it does not apply here. */
function manifestHookEvents(root: string): string[] {
  for (const rel of [[".claude-plugin", "plugin.json"], ["plugin.json"]]) {
    const f = join(root, ...rel);
    if (!existsSync(f)) continue;
    try {
      const doc = JSON.parse(readFileSync(f, "utf8")) as { hooks?: unknown };
      const h = doc?.hooks;
      if (!h || typeof h !== "object" || Array.isArray(h)) return [];
      return Object.keys(h as Record<string, unknown>).filter((k) => typeof k === "string");
    } catch {
      return []; // malformed manifest is the mount/lint path's problem, not this gate's
    }
  }
  return [];
}

/** Plugin roots that declare RUNNABLE hooks, from EITHER channel:
 *   - `<plugin>/hooks/hooks.json` — placement is load-bearing. The binary reads exactly that path, and
 *     the identical file at the plugin ROOT fires nothing, so a root-level copy must NOT count or the
 *     consent gate would refuse a run over a file that cannot execute.
 *   - the plugin MANIFEST's `hooks` key — live wherever the manifest is, no placement carve-out.
 *  Returns the UNION of their event names. Both consumers (the consent gate and the disclosure) call
 *  through here, so covering both channels in one place fixes both. */
export function pluginRootsWithRunnableHooks(pluginRoots: string[]): Array<{ root: string; events: string[] }> {
  const out: Array<{ root: string; events: string[] }> = [];
  for (const root of pluginRoots) {
    const events = new Set<string>();
    for (const f of findHooksFiles(root)) {
      if (!f.endsWith(`${sep}hooks${sep}hooks.json`)) continue; // misplaced ⇒ inert ⇒ not a hazard
      for (const name of declaredHookEvents(f)) events.add(name);
    }
    for (const name of manifestHookEvents(root)) events.add(name); // live regardless of placement
    if (events.size > 0) out.push({ root, events: [...events].sort() });
  }
  return out;
}

/**
 * L0 host-execution consent. `protocol` passes `--plugin-dir`, and the CLI runs a plugin's hooks as
 * NATIVE HOST PROCESSES — the operator's account, the operator's env, no container. At `container` and
 * `microvm` those hooks run inside the sandbox; at `hostloop` they already run on the host and that tier
 * has its own consent gate (`checkHostLoopWriteConsent`). `protocol` had neither, because before the
 * plugin-delivery fix it never loaded the plugin at all.
 *
 * Gate ONLY when there is something to execute: a plugin the scenario actually staged declares runnable
 * hooks. An ordinary skill-under-test declares none and is unaffected.
 */
export function checkHostHookConsent(pluginRoots: string[], allowHostHooks: boolean): void {
  if (allowHostHooks) return;
  const declaring = pluginRootsWithRunnableHooks(pluginRoots);
  if (declaring.length === 0) return;
  const detail = declaring.map((d) => `${d.root} (${d.events.join(", ")})`).join("; ");
  throw new Error(
    `protocol fidelity stages a plugin whose hooks would run as NATIVE HOST PROCESSES — your account, ` +
      `your environment, no container sandbox: ${detail}. This tier passes --plugin-dir, so the CLI ` +
      `executes these hooks directly on this machine. This requires explicit consent: for a \`run\` ` +
      `scenario add \`allow_host_hooks: true\` to the YAML; for \`chat\`/\`skill\` pass ` +
      `--allow-host-hooks. Use --fidelity container to run them sandboxed instead.`,
  );
}

/** The per-run disclosure, emitted even when consent was given in committed YAML — consent once should
 *  still be visible every run. Never gated by `--compact` (a safety disclosure, not decorative output),
 *  mirroring `logHostWriteNotice`. */
export function logHostHookNotice(pluginRoots: string[], warn: (m: string) => void): void {
  for (const d of pluginRootsWithRunnableHooks(pluginRoots)) {
    warn(`::warning:: [protocol] ${d.root} hooks run as native host processes (${d.events.join(", ")}) — no container sandbox\n`);
  }
}

/** `hook_output_*` reads every `hook_response` frame for an event, and a frame carries no plugin id — so when
 *  more than one staged plugin declares the asserted event, or host hooks are allowed (`allow_host_hooks`), the
 *  output cannot be attributed to the plugin under test: another hook's text can satisfy `hook_output_contains`
 *  or fail `hook_output_not_contains`. Emitted regardless of `--compact`: it qualifies what a verdict means,
 *  like the host-hook disclosure, rather than decorating the run. Never throws. */
export function warnAmbiguousHookOutput(
  pluginRoots: string[],
  asserts: ReadonlyArray<{ hook_output_contains?: { event: string }; hook_output_not_contains?: { event: string } }>,
  allowHostHooks: boolean,
  warn: (msg: string) => void,
): void {
  const events = new Set<string>();
  for (const a of asserts)
    for (const v of [a.hook_output_contains, a.hook_output_not_contains]) if (v && typeof v.event === "string") events.add(v.event);
  if (events.size === 0) return;
  let declaring: Array<{ root: string; events: string[] }> = [];
  try {
    declaring = pluginRootsWithRunnableHooks(pluginRoots);
  } catch {
    return;
  }
  for (const ev of [...events].sort()) {
    const roots = declaring.filter((d) => d.events.includes(ev)).map((d) => d.root);
    const reasons: string[] = [];
    if (roots.length > 1) reasons.push(`${roots.length} staged plugins declare \`${ev}\` (${roots.join(", ")})`);
    if (allowHostHooks) reasons.push("`allow_host_hooks` is set, so a host hook may also answer it");
    if (reasons.length)
      warn(
        `::warning:: [hooks] hook_output_* on \`${ev}\`: ${reasons.join("; ")} — hook_response frames carry no plugin id, ` +
          `so the output graded cannot be attributed to one hook. Stage only the plugin under test, or match text only it prints.\n`,
      );
  }
}
