import { readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { parse } from "yaml";
import { listSkillFilesRecursive } from "./corpus-walk.js";

/** One sub-agent file the graded skill can dispatch, resolved for packaging into the evaluator corpus. */
export interface ResolvedAgent {
  /** The agent's DECLARED name — frontmatter `name:`, falling back to the filename stem. This, not the
   *  filename, is what a `subagent_type` literal resolves against. */
  name: string;
  absPath: string;
  /** Plugin-ROOT-relative POSIX key (`agents/x.md`, `agents/sub/x.md`). The agents dir sits outside
   *  `skillDir`, so this is the only key that can be checked against the tracked set staging used. */
  rel: string;
  /** WHY this agent is in the corpus: `skill-named`, or `<file>:<line>` of the `subagent_type` literal
   *  that pulled it in. Rendered into the section title so the evaluator can weigh an agent that a
   *  reference doc merely MENTIONS (a template placeholder, or a "never dispatch this" example) against
   *  one the skill really dispatches. The extraction regex has no context awareness — see the module
   *  note below — so provenance is the mitigation, not a cleverer regex. */
  via: string;
}

/** The pinned-`subagent_type` shape. Deliberately byte-identical to `_SUBAGENT_TYPE_RE` in
 *  `.claude/skills/cowork-harness/scripts/scenario.py` — the two implementations are pinned by a shared
 *  behavioural fixture (`test/fixtures/dispatchable-agents.json`), NOT by comparing these two strings,
 *  because a source-text compare passes while the two disagree on any input either one mis-parses. */
const SUBAGENT_TYPE_RE = /subagent_type\s*[:=]\s*['"]?([A-Za-z0-9_.:/-]+)['"]?/g;

/** Frontmatter `name:` of an agent markdown, or undefined. Mirrors `_agent_name_from_frontmatter`:
 *  a missing/malformed/absent-`name` frontmatter is not an error, it just means "fall back to the stem". */
function declaredAgentName(absPath: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return undefined;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return undefined;
  try {
    const fm = parse(content.slice(content.indexOf("\n") + 1, end));
    if (fm && typeof fm === "object" && typeof (fm as Record<string, unknown>).name === "string") {
      const n = ((fm as Record<string, unknown>).name as string).trim();
      return n.length > 0 ? n : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The plugin's own `name` (`.claude-plugin/plugin.json`, falling back to `plugin.json`), or undefined
 *  when neither exists or parses. Mirrors `_read_plugin_name`; never throws. */
export function readPluginName(pluginRoot: string): string | undefined {
  for (const rel of [join(".claude-plugin", "plugin.json"), "plugin.json"]) {
    try {
      const raw = JSON.parse(readFileSync(join(pluginRoot, rel), "utf8")) as unknown;
      if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).name === "string") {
        const n = ((raw as Record<string, unknown>).name as string).trim();
        if (n.length > 0) return n;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Every `*.md` under `<pluginRoot>/agents/`, RECURSIVELY, with its declared name. Recursive on purpose:
 *  Claude Code discovers `agents/sub/x.md` (see `src/run/analyze-skill.ts:981-983`) and `skill-hash.ts`'s
 *  `agentSkillName` already attributes both the flat and nested shapes, so a nested agent is dispatchable,
 *  hash-attributed and analyze-scanned. A non-recursive glob here would have hard-coded the flat
 *  assumption in a THIRD place while two subsystems already contradict it. */
export function enumeratePluginAgents(pluginRoot: string): Array<{ name: string; absPath: string; rel: string }> {
  const agentsRoot = join(pluginRoot, "agents");
  return listSkillFilesRecursive(agentsRoot)
    .filter((rel) => rel.toLowerCase().endsWith(".md"))
    .map((rel) => {
      const absPath = join(agentsRoot, rel);
      return { name: declaredAgentName(absPath) ?? basename(rel, ".md"), absPath, rel: `agents/${rel}` };
    });
}

/** Pinned `subagent_type` literals in `text`, with 1-based line numbers. */
function literalsIn(text: string): Array<{ value: string; line: number }> {
  const out: Array<{ value: string; line: number }> = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    SUBAGENT_TYPE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SUBAGENT_TYPE_RE.exec(lineText)) !== null) out.push({ value: m[1]!, line: i + 1 });
  });
  return out;
}

/** Resolve a pinned literal to a declared agent name WITHIN this plugin, or undefined.
 *
 *  A colon-bearing literal is namespaced (`<plugin>:<agent>`) and its prefix MUST equal this plugin's
 *  name — otherwise a cross-plugin `other-plugin:market-sizing` would match this plugin's `market-sizing`
 *  and package a body the graded skill never dispatches. A bare literal matches a declared name directly.
 *  Both forms are pinned in the cross-language fixture, because leaving this rule unstated is precisely
 *  how the TS and Python resolvers would drift. */
function literalToAgentName(value: string, pluginName: string | undefined): string | undefined {
  const idx = value.indexOf(":");
  if (idx === -1) return value.length > 0 ? value : undefined;
  if (pluginName === undefined) return undefined; // can't prove the namespace is ours
  const prefix = value.slice(0, idx);
  const suffix = value.slice(idx + 1);
  return prefix === pluginName && suffix.length > 0 ? suffix : undefined;
}

/** Every agent the graded skill can dispatch, as its own corpus entry.
 *
 *  The set is the UNION of three clauses, and the union IS the safety property: a skill that dispatches
 *  dynamically (no pinned literal anywhere) must keep the evidence it already gets, so this can never
 *  resolve to LESS than the single `agents/<skillName>.md` the packager shipped before.
 *    1. `agents/<skillName>.md` by FILENAME — exactly what `agentsMdFor` did.
 *    2. every in-plugin agent a pinned `subagent_type` literal in SKILL.md / `references/**` resolves to.
 *    3. every agent whose DECLARED name equals the skill name — clause 1 is filename-keyed by necessity
 *       (it must reproduce the old behaviour byte-for-byte), so a plugin whose `agents/redteam.md`
 *       declares `name: market-sizing` and pins no literal was packaging NOTHING. That was a live defect
 *       at N=1, independent of the multi-agent gap.
 *
 *  Then a TRANSITIVE closure: an agent body that pins `subagent_type` dispatches that agent during the
 *  graded turn too, so its guidance is just as absent. Closing to a fixpoint over the resolved bodies
 *  fixes the headline defect at depth 2 instead of re-creating it one level down. `|agents|` bounds the
 *  loop and a visited set makes a dispatch cycle terminate.
 *
 *  NOT bounded from above by construction: a router-style skill pinning every agent resolves to the same
 *  set a blanket `agents/**` glob would. The 512 KiB corpus ceiling is the only backstop, and an agent
 *  file can now push SKILL.md into a cut — a new failure mode, made graceful (not cliff-edged) by the
 *  smallest-first allocator in `package-evidence.ts`. */
export function resolveDispatchableAgents(pluginRoot: string, skillDir: string, skillName: string | undefined): ResolvedAgent[] {
  const all = enumeratePluginAgents(pluginRoot);
  if (all.length === 0) return [];
  // No manifest: the agent names a plugin after its folder (`binaryPluginIdentity`), so a `<folder>:<agent>` literal
  // dispatches this plugin's agent. Same fallback as the reference resolver; `readPluginName` itself stays as it is.
  const pluginName = readPluginName(pluginRoot) ?? basename(pluginRoot);
  const picked = new Map<string, ResolvedAgent>(); // absPath -> entry; first `via` wins
  // Declared BEFORE `add` on purpose: every picked agent is itself a dispatch SOURCE, so `add` pushes it.
  // Clauses 1 and 3 used to add without pushing, and clause 2 pushed only when `add` returned true — so a
  // skill's own primary agent (the most likely dispatcher of a second agent) was never scanned, and the
  // transitive closure this function advertises did not run for the dominant real shape.
  const frontier: Array<{ label: string; absPath: string }> = [];

  const add = (entry: { name: string; absPath: string; rel: string }, via: string): boolean => {
    if (picked.has(entry.absPath)) return false;
    picked.set(entry.absPath, { ...entry, via });
    frontier.push({ label: entry.rel, absPath: entry.absPath });
    return true;
  };

  if (skillName !== undefined) {
    // clause 1 — filename-keyed, byte-identical to the old `agentsMdFor`
    const byFile = all.find((a) => a.rel === `agents/${skillName}.md`);
    if (byFile) add(byFile, "skill-named");
    // clause 3 — declared name equals the skill name
    for (const a of all.filter((a) => a.name === skillName)) add(a, "skill-named");
  }

  // clause 2 + transitive closure. The frontier starts as the skill's own authored text and grows with
  // each resolved agent body; `scanned` keeps a cyclic dispatch from looping.
  const scanned = new Set<string>();
  const skillMd = join(skillDir, "SKILL.md");
  if (existsSync(skillMd)) frontier.push({ label: "SKILL.md", absPath: skillMd });
  const refRoot = join(skillDir, "references");
  for (const rel of listSkillFilesRecursive(refRoot)) frontier.push({ label: `references/${rel}`, absPath: join(refRoot, rel) });

  while (frontier.length > 0) {
    const src = frontier.shift()!;
    if (scanned.has(src.absPath)) continue;
    scanned.add(src.absPath);
    let text: string;
    try {
      text = readFileSync(src.absPath, "utf8");
    } catch {
      continue; // unreadable/binary reference file — same degrade posture as the packager itself
    }
    for (const { value, line } of literalsIn(text)) {
      const agentName = literalToAgentName(value, pluginName);
      if (agentName === undefined) continue; // cross-plugin or unresolvable — not this plugin's guidance
      for (const a of all.filter((a) => a.name === agentName)) add(a, `${src.label}:${line}`);
    }
  }

  return [...picked.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}
