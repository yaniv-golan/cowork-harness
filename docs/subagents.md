# Sub-agents under Cowork fidelity

A sub-agent (dispatched via the `Task` tool) runs under a different capability and path model than
the main loop, and that model changes shape between host-loop and the VM-loop tiers. This page is the
reference for what a sub-agent can reach, what tools it ends up with, and where the two loops diverge
— read it before writing (or asserting) any skill that dispatches sub-agents.

## Canonical outputs addressing — TIER-QUALIFIED (there is no single cross-tier literal form)

**Host-loop (production default; `fidelity: hostloop`):**
1. cwd-relative `artifacts/<...>` — the stable skill-author contract. The sub-agent's file-tool cwd
   IS the host outputs dir, so a relative path resolves against it directly.
2. A host-absolute staged path also works, but it is private/session-specific — never present it as a
   portable contract.

Never `/sessions/...` on this tier — the path gate denies it unconditionally (a byte-faithful port of
production's own host-loop resolver), steering shell work to the `bash` tool, which runs inside the VM
sidecar instead.

**VM loop (`container` / `microvm` / forced-VM):** the agent cwd is `/sessions/<id>`, there is no path
gate, and `/sessions/...` is valid:
1. cwd-relative `mnt/outputs/artifacts/<...>`, or
2. absolute `/sessions/<id>/mnt/outputs/artifacts/<...>`.

Bare `artifacts/<...>` on a VM tier resolves to `/sessions/<id>/artifacts` — sandbox scratch OUTSIDE
the outputs mount: not denied, just silently non-deliverable (nothing collects it as a user-visible
artifact). A skill meant to work across tiers must anchor its output path on the outputs mount, never
on one hardcoded relative form.

## Static path-fidelity check (`analyze-skill`)

`cowork-harness analyze-skill <SKILL.md | skill-dir/ | glob>…` catches the "hands a `/sessions/...` path
to a file tool" defect described above **statically**, token-free — no Docker, no model call, no live
host-loop run — by scanning a SKILL.md's text. It reuses the harness's own ported `/sessions` path-gate
predicate (`isVmSessionsPath`) as the DENY decision; the only heuristic part is extracting candidate
paths out of markdown text.

**Multiple positionals are accepted, matching `lint-skill`'s `nargs="+"`** — `analyze-skill a/SKILL.md
b/SKILL.md`, `analyze-skill skill-a/ skill-b/`, or a mix of files, dirs, and globs in one call. A
positional containing `*` is expanded by a small hand-rolled glob matcher (no dependency, no
`engines.node` bump): `dir/*.md` matches shallowly (one level under `dir`); `dir/**/*.md` matches
recursively, reusing the same symlink-following, loop-guarded walker the directory-target union scan uses
(see below). Every positional's file set is UNIONed and deduped by resolved absolute path ACROSS THE
WHOLE INVOCATION — a file reached both directly and through a dir/glob positional is analyzed once, not
twice. Zero scannable files across ALL positionals is a usage error (exit 2); an unresolvable single positional (a missing
path, or a glob shape other than the two above) fails the whole invocation the same way.

**A directory target scans the UNION of every contract-bearing markdown file present, not just
`SKILL.md`.** A plugin's dispatch/output contracts often live in `agents/*.md` or `references/*.md` —
scanning only `SKILL.md` there is a false green. Pointing `analyze-skill` at a directory expands it to
every shape the directory matches, deduped by resolved absolute path (a directory can match more than
one shape at once — this repo's own `.claude/skills/cowork-harness/` is simultaneously a
top-level-`SKILL.md` dir AND a plugin root):

- a top-level `SKILL.md` present → that file, plus every markdown file recursively under top-level
  `references/`;
- a `.claude-plugin/plugin.json` or bare `plugin.json` present (a plugin root) → every markdown file
  RECURSIVELY under root `agents/`, `references/`, and `commands/` — Claude Code discovers namespaced
  commands/agents in subdirectories (`commands/tasks/build.md`, `agents/sub/x.md`), so these are `**`
  walks, not a single-level listing — and each `skills/<name>/SKILL.md` (plus every markdown file
  recursively under that skill's own `references/`); `skills/<name>` may itself be a directory symlink
  and is still picked up;
- a skill dir INSIDE a plugin (its own `SKILL.md` present, and walking UP the directory tree finds an
  enclosing plugin manifest) → ALSO every markdown file RECURSIVELY under the enclosing plugin's root
  `agents/`, `references/`, AND `commands/` — the same contract dirs scanned in every other shape above,
  so a skill-dir target is never narrower than a plugin-root target for the same plugin.

A FILE target is unchanged — just that one file. Every `**` walk above is a hand-rolled directory walker
(no glob dependency) that **FOLLOWS directory symlinks** — a symlinked `references/`/`agents/`/`commands/`
(or a symlinked file inside one) is a real, scannable contract surface, not a boundary to silently drop —
guarded against a symlink LOOP (e.g. `references/loop -> ..`) by a realpath visited-set threaded through
the whole walk, so a self-referencing symlink becomes one harmless extra pass, never infinite recursion. It
matches `.md`/`.MD` case-insensitively and skips `node_modules`, `.git`, and any dot-prefixed directory.
**ZERO scannable files under a directory target is a USAGE ERROR (exit 2)**, never a silent clean pass —
the error message enumerates every shape it looked for.

The `--output-format json` payload nests per-file results under a `files:` key —
`{tool, version, command, ok, files: [{file, findings, suppressed}], scanned, unscanned, strict, error}`
— never a bare array, never `results[]`. `scanned` lists every file analyzed; `unscanned` names entries
deliberately left out of THIS target's scope — a `skills/<name>` dir with no `SKILL.md` (not a scannable
skill dir), or a sibling skill dir in the enclosing plugin when the target is one skill dir inside that
plugin, not the plugin root — printed as a scope banner in text mode too, so a narrower-than-expected scan
is never silent. `ok`/`--strict` are computed across ALL scanned files: `ok` is true only when every file
has zero findings, and `--strict` fails (exit 1) if ANY file has an unsuppressed finding. The `analyze-skill:
ignore` marker (and the two scoped markers below) apply PER FILE — silencing one scanned file has no
effect on any other file in the union.

> **Migrating from a single-`SKILL.md`-only scan (pre-0.32):** a directory target that previously scanned
> only `SKILL.md` may newly surface findings in `references/`/`agents/`/`commands/` teaching examples that
> were never looked at before — including one nested under a subdirectory or reached only via a symlink,
> both now scanned — annotate those with `analyze-skill: ignore-next-line` or an
> `ignore-start`/`ignore-end` fence (see below) rather than reaching for the file-wide marker. The
> `--output-format json` shape also changed: a single-file target's flat `{file, findings, suppressed,
> strict}` became `{files: [{file, findings, suppressed}], scanned, unscanned, strict}` for uniformity
> with the multi-file case — an external `jq '.findings'`/`.file` recipe needs `jq '.files[0].findings'`/
> `.files[0].file` instead.

**ADVISORY by default.** Because the extraction is heuristic and can over-flag innocent
documentation/teaching examples, findings print as warnings but the command **exits 0 by default even
when it prints findings**. Pass `--strict` to turn it into a hard gate — exit 1 on any finding, mirroring
`lint-skill --strict` exactly.

**Three ignore markers, three scopes.** A SKILL.md can silence findings at the granularity that fits the
false positive — from a single teaching line up to the whole file:

- **`analyze-skill: ignore-next-line`** — suppresses findings on the SINGLE line immediately following
  the marker line. The narrowest tier: use it right above one teaching example (`❌ Write(/sessions/...)`
  in a "don't do this" callout, a one-line illustrative snippet) without touching anything else in the
  file.
- **`analyze-skill: ignore-start`** … **`analyze-skill: ignore-end`** — suppresses findings on every line
  from `ignore-start` through the matching `ignore-end`, inclusive. Use it to wrap a multi-line teaching
  block — e.g. a `references/`/`agents/` code sample that legitimately demonstrates `/sessions` addressing
  for a VM-tier reader. A `ignore-start` with **no matching `ignore-end` before EOF** is itself a finding
  — `unclosed-ignore-fence` — that prints and gates under `--strict` exactly like any other finding (it
  still suppresses everything from the stray `ignore-start` to EOF, fail-open, but the missing-`ignore-end`
  mistake itself is never silent).
- **`analyze-skill: ignore`** (file-wide, unchanged) — silences the ENTIRE warning class for the file,
  including a genuine true positive, since this is an explicit whole-file author override, not a narrower
  false-positive guard. Use it on a SKILL.md that legitimately uses `/sessions` paths throughout (a
  VM-tier-only skill). Under `--strict`, a file-wide-suppressed file never fails, and it never emits
  `unclosed-ignore-fence` either — the whole-file override wins outright.

All three accept the same wrappers as the file-wide marker: bare (`analyze-skill: ignore-next-line`), an
HTML comment (`<!-- analyze-skill: ignore-start -->`), a markdown reference-link comment
(`[//]: # (analyze-skill: ignore-end)`), a `#`-prefixed line, or a list bullet (`- analyze-skill:
ignore-next-line`). Every marker is **line-anchored** — the marker text must be the line's ENTIRE
meaningful content (allowing only the wrapper and whitespace) to take effect; a SKILL.md that merely
*documents* one of these markers in prose (e.g. `` add `analyze-skill: ignore-next-line` to skip a line
``) does not accidentally trigger it.

**Teaching examples in `references/`/`agents/` — the pattern this unlocks.** A skill's `references/` or
`agents/` files often carry a deliberately WRONG code sample under a "don't do this" heading — exactly the
`/sessions`-to-file-tool shape this analyzer flags, but as a teaching illustration, not a live defect. Wrap
just that sample in `ignore-start`/`ignore-end` (or prefix the one bad line with `ignore-next-line`)
instead of reaching for the file-wide marker — the rest of the file, including any REAL `/sessions`
mistake introduced later, stays fully scanned.

Three rules, all advisory findings — including `unclosed-ignore-fence`, which fires on this file's own
ignore-marker syntax rather than on `/sessions` addressing:

- **`sessions-path-to-file-tool`** — a `/sessions/...` token in a file-tool/output POSITIVE context: an
  `OUTPUT_PATH=`/`OUTPUT_DIR=` assignment, a `Write(`/`Read(`/`Edit(`/`Glob(`/`Grep(` directive target,
  IMPERATIVE prose instructing a write/save/read/edit "to"/"at" the path, or a BARE `/sessions/...` path
  line/value sitting inside a fenced block that also contains a `Task(` call or `subagent_type` (a
  dispatch construct) — a path embedded inside a larger sentence or a bash-mediated command string within
  that same block does not count as "bare".
- **`sessions-find-into-file-read`** — a shell `find … /sessions …` whose output is substituted straight
  into a `Read(`/`Grep(` directive: same line, or the very next line AND the directive's body references
  the find line's OUTPUT-CAPTURE variable specifically — a `VAR=$(find …)` assignment or a
  `find … > $VAR`/`> VAR` redirection — not merely any `$VAR` token that happens to appear on the find
  line (an `-name "$NAME"` argument is find's INPUT, not its output, and sharing that token with an
  unrelated `Read(` does not fire).
- **`unclosed-ignore-fence`** — an `analyze-skill: ignore-start` line with no matching `ignore-end` before
  EOF. Not a `/sessions`-addressing finding at all — a syntax mistake in the file's OWN ignore markup,
  reported so a forgotten `ignore-end` (which would otherwise fail-open and silently blind the rest of the
  file) is never a silent stderr-only notice on a green exit.

**Context confidence governs which guards apply.** HIGH-confidence STRUCTURED contexts — an
`OUTPUT_PATH=`/`OUTPUT_DIR=` assignment, a `Write(`/`Read(`/`Edit(`/`Glob(`/`Grep(` directive target, and a
bare `/sessions/...` path LINE inside a dispatch construct — are machine-unambiguous and fire regardless of
a neighboring anti-instruction word or a stray "bash" mention elsewhere on the line: an author writing
`Write(/sessions/...)` next to "Do not modify any other file." is still handing a `/sessions` path to a
file tool. The LOW-confidence PROSE idiom ("write/save/read/edit ... to/at `/sessions/...`") keeps the
whole-line/adjacent-line negation guard and the bash-tool suppression, since that context is the one where
a genuine remediation ("Use the bash tool to write ... to `/sessions/...`") or an anti-instruction ("Never
write to `/sessions/...`") is ambiguous without them. A STRUCTURED context instead gets a much NARROWER
carve-out: a negation token in the SAME CLAUSE as the directive/assignment itself (not merely the same or
an adjacent line) suppresses it — the genuine teaching idiom "❌ Write(/sessions/...) — never do this; use
the bash tool instead." — while an unrelated same-or-adjacent-line negation still fires.

**EXEMPT by design** (false-positive guards, deliberately conservative — "when unsure, do not flag"):
a `/sessions` token inside a ` ```bash `/`sh`/`shell`/`zsh`/`console`/`*-session` fenced block (matched by
exact language name, not a prefix — a ` ```shiny ` fence is not bash-ish just because it starts with "sh"),
or the same fence blockquoted with `> `, is legitimate in-VM bash and is never scanned; the fence opener's
language is read as the first word only, so a trailing info-string (` ```bash title="x" `) doesn't defeat
the exemption and doesn't leave a phantom fence open for later content to cascade into; a 4-space/tab
INDENTED unfenced block is treated the same way UNLESS the run of indented lines carries a dispatch marker
(`Task(`/`subagent_type`) outside a `#` comment (in which case it is analyzed like a fenced dispatch block
instead — see "Honest limits" below); a line carrying an anti-instruction word (`never`, `don't`, `do not`,
`avoid`, `not`) on that line OR the immediately adjacent line suppresses ONLY the prose context, not a
structured one (see above); the prose context's bash suppression has two tiers — the INSTRUMENT phrase
"bash tool" (or "the bash tool") suppresses if it appears ANYWHERE on the line, even in a fronted clause
severed by a comma ("Using the bash tool, write ... to `/sessions/...`") or a trailing clause after the
path ("Write ... to `/sessions/...` using the bash tool."); a BARE "bash" mention (no "tool") is narrower
and stays scoped to the CLAUSE that links the verb to the path — an unrelated, punctuation-severed earlier
clause naming "bash" (e.g. "the bash step", not "the bash tool") does not suppress a genuinely different
instrument; passive-voice documentation prose ("Deliverables are saved at ...", "Uploads are read-only at
...") does not count as an imperative instruction; plain prose that documents a fact (e.g. "the VM cwd is
`/sessions/<id>`") without any of the positive contexts above is left alone. A token that matches more than
one positive context on the same line (e.g. an `OUTPUT_PATH=` line that also sits inside a
dispatch-construct fence) is reported once, not once per matching context.

**Honest limits.** Only the extraction is heuristic — the deny decision is the same one production
enforces. Documented false negatives: a variable-carried path (`$OUT/...` where the literal value isn't
`/sessions`), a `/sessions` path written only in an INDENTED (4-space/tab) unfenced code block that does
NOT carry a dispatch marker — treated as an exempt code context, the same as a fenced bash block, since an
unfenced VM-bash template written this way is legitimate in-VM bash, not a violation. An indented block
that DOES carry a dispatch marker (`Task(`/`subagent_type`) is NOT exempt — it is analyzed the same way a
fenced dispatch block is, since an indented dispatch template is this analyzer's headline defect class,
not VM bash (a blank line inside such a run does not defeat this — the run is still grouped as one, and a
`Task(`/`subagent_type` mention inside a `#` comment does not count as the marker). Also a documented
false negative: a prose-only dispatch instruction (no fenced or indented block), and — deliberately
unaddressed, to avoid new false positives from expanding dispatch detection into bash fences — a
` ```bash `-FENCED dispatch template (`Task(` plus `OUTPUT_PATH=/sessions/...` inside a bash fence) stays
silent, as do a lowercase `output_path` / JSON quoted-key `"output_path"` inside a fence, and a
no-comma prose variant of the dispatch-argument shape. Two decision-class misses are out of v1 scope
entirely: an absolute HOST path outside connected folders (denied by containment, not the `/sessions`
rule) and a write into a read-only category (uploads/spool/plugin content) — neither is a `/sessions`
finding, so this analyzer doesn't claim to catch them.

**`analyze-skill` gates the HOST-LOOP path model only.** A skill authored exclusively for a VM tier
(`container`/`microvm`), where `/sessions` is a valid, ungated path, is not what this analyzer is meant to
clear — a clean result there isn't meaningful, and a firing result on such a skill is a false alarm for
that tier (the finding message names the tier explicitly so this is visible at read time, but `analyze-skill`
itself has no way to know which tier(s) a given SKILL.md targets). Run it against skills meant to work
on host-loop, or skills written to work across tiers via the tier-qualified addressing above.

**A clean or suppressed `analyze-skill` is a PRE-FLIGHT signal, not proof of on-tier resolution.** The
authoritative check remains the runtime `no_vm_path_file_op` / `vm_path_denied` assertions (see
[scenario.md](./scenario.md)) against a real recorded/live run — `analyze-skill` exists to catch the
obvious cases before paying for that run, not to replace it.

### Interactive-artifact write-backs (`artifact-write-back-*`)

Beyond `/sessions` addressing, `analyze-skill` flags a **Cowork-specific** bug class: a skill that emits
an interactive HTML artifact (a form, a review dashboard) whose "Submit" does a client-side write-back
that silently never reaches the agent. Under Cowork the artifact is served from Cowork's **own origin**,
so a relative `fetch("/api/…", {method:"POST"})` / XHR-POST / `sendBeacon("/…")` / `<form method=post
action="/…">` **resolves but returns non-ok**; a page that doesn't check `resp.ok` shows a false
"Saved!" (and the common blob-download fallback is also broken in Cowork's embedded viewer). A live
harness run is structurally blind to this (no browser, no human — see
[fidelity-gaps.md](./fidelity-gaps.md)), so it is caught statically instead.

`analyze-skill` scans `.html/.htm/.js/.mjs/.ts/.jsx/.tsx/.py` sources under the target (its OWN source
set — the `.py`/`.js` *generator* that emits the HTML is scanned too, since the write-back string often
lives in a template) and emits:

- **`artifact-write-back-lost`** (severity `error` — gates under `--strict`) — a relative write-back with
  a lost consequence: a broken download fallback, an unchecked success claim, or a native
  `<form method=post>` (no JS handler, so `resp.ok` can't be checked).
- **`artifact-write-back-suspect`** (severity `advisory` — never gates on its own) — a relative write-back
  with a fully-local graceful fallback, or one behind a guard whose runtime value can't be statically
  proven truthy. A merely *lexical* `is_static`-style guard does NOT clear a candidate to clean.
- **could-not-verify** (`analysisFailures`, exit `3`, always — `--strict`-independent) — a candidate that
  couldn't be parsed/analyzed. A candidate you can't check is never a silent pass. A strict `error`
  finding's exit `1` takes precedence over exit `3`.

These artifact rules are **not** silenced by the `analyze-skill: ignore` marker (that marker only affects
the `/sessions` path-fidelity rules). Documented false negative: a generator whose markers/URLs are
themselves computed is missed by the static tier — that's what `--runtime` is for.

**`--runtime` (optional runtime confirmation).** Drives each materialized `.html` artifact in a headless
DOM (jsdom): it stubs the network, fires synthetic user actions, and runs twice (server-200 vs -404) to
**observe** whether a relative write-back fires and is lost (final DOM identical across 200/404, response
never consulted, or an attributed blob-download). The verdict (`lost`/`suspect`/`clean`/`inconclusive` +
evidence) is attached to the output as `runtimeConfirmations`. It is **enrichment only — it never changes
the exit code.** `jsdom` is an optional, dynamically-imported dependency (`npm i jsdom` to enable);
without it, `--runtime` reports that once. It executes artifact JS in-process, so it is for a
**trusted-source scope** (an author testing their own skill), not adversarial third-party skills.

**Recipe — confirm artifacts the agent GENERATED at run time.** `analyze-skill` scans a skill's *source*,
which catches artifacts (and their `.py`/`.js` generators) that ship in the skill. But an artifact the
model *builds during a run* — HTML written straight to `outputs/`, or emitted by a generator whose output
the static scan couldn't isolate — doesn't exist until the run happens. Because `analyze-skill` accepts a
bare directory (no `SKILL.md` required), you confirm those directly by pointing `--runtime` at a completed
run's outputs directory:

```bash
# container / hostloop runs:
cowork-harness analyze-skill --runtime "<run-dir>/work/session/mnt/outputs" --output-format json
# protocol runs: the outputs dir is <run-dir>/work/outputs
```

The `<run-dir>` is printed on `stderr` as `[status] <dir>` at run start (or find it with
`cowork-harness trace <run-id>`). This is the same confirmer as above — `runtimeConfirmations` in the JSON,
enrichment only, needs `jsdom` installed. Caveats: it confirms whatever `.html` is present in that dir
(agent output AND any author fixtures there); on **`microvm`** the agent's outputs are **not** staged into
the run dir (a known artifact-collection gap), so this recipe has nothing to read for a microvm run; and a
**replay** run dir has no live filesystem to scan.

## Static `subagent_type` resolution (`resolve-agent-types` / `lint-skill`)

A pinned `subagent_type` value that doesn't resolve to a real agent (e.g.
`founder-skills:cap-table` when the agent is actually named `captable`) fails a definition lookup at
`Task` dispatch time and breaks the skill — but until now that was only discoverable via a live
dispatch. `scenario.py` resolves it **statically**, token-free, from a plugin's own manifest and
agent frontmatter:

- **`scenario.py resolve-agent-types <plugin-dir>`** — reads the plugin's `name` from
  `<plugin-dir>/.claude-plugin/plugin.json` (fallback `<plugin-dir>/plugin.json`), globs
  `<plugin-dir>/agents/*.md`, and for each file reads the `name:` YAML frontmatter field (falling
  back to the filename stem — `foo.md` → `foo` — when a file has no `name:`). Prints the resulting
  `{plugin}:{agent}` set, one per line or as a JSON array with `--json`. A dir with no plugin.json
  prints an empty set (exit 0) — a bare SKILL.md dir with no plugin manifest has nothing to resolve
  against, and this never crashes.
- **Folded into `scenario.py lint-skill`** — the SKILL.md body scan also extracts every pinned
  `subagent_type` value (`subagent_type: <value>` YAML, `subagent_type="<value>"` /
  `subagent_type: "<value>"` dispatch-prose forms — not limited to fenced blocks), resolves the
  enclosing plugin by walking up from the SKILL.md to the nearest ancestor with a
  `.claude-plugin/plugin.json`/`plugin.json`, and classifies each value:
  - resolves within that plugin's `agents/`, or is literally `general-purpose` → clean, no finding;
  - a `<this-plugin>:<agent>` (colon-qualified, prefix EQUALS this plugin's own name) whose `agent`
    is missing from that plugin's fully-enumerated `agents/*.md` → **`subagent-type-not-found-in-plugin`**
    — "names this plugin but that agent doesn't exist — likely a typo";
  - a `<other-plugin>:<agent>` (colon-qualified, prefix isn't this plugin's name) →
    **`subagent-type-unresolvable`** — "belongs to another plugin, can't confirm it resolves from
    here";
  - any other unresolved value → **`subagent-type-unknown`** — "not defined in this plugin and not
    the `general-purpose` built-in, can't confirm statically (may be an agent-binary built-in)".

**`subagent-type-not-found-in-plugin` is WARN — it's a provable typo, not an unconfirmable unknown.**
The namespace prefix already commits the value to THIS plugin, and the plugin's agent set was fully
enumerated from `agents/*.md`, so a miss there can never be another binary's built-in agent hiding
from static analysis — it's simply wrong. Being provable, it's promoted out of INFO so
`lint-skill --strict` gates on it (exit 1).

**The other two, `subagent-type-unresolvable` and `subagent-type-unknown`, stay INFO, never WARN — by
design, not an oversight.** There is no harness registry of built-in agent types (`Explore`,
teammate-style built-ins, etc.) to disprove an unresolved bare value or a cross-plugin reference
against — the built-in set is agent-binary-version-dependent and the harness deliberately does not
ship a committed list of it (it would go stale and either false-warn a real built-in or false-clear a
typo). So those two are always *surfaced*, never *failed*, even under `--strict`. If you want a
stronger guarantee for a specific agent, name it as `general-purpose` explicitly or ship it under the
same plugin's `agents/` so it resolves in-plugin.

**Run `lint-skill --strict` in CI, not plain `lint-skill`.** Plain `lint-skill` is advisory-only —
it prints every finding (WARN and INFO alike) but exits 0. `--strict` is what turns the two
host-loop-footgun WARNs and the provable `subagent-type-not-found-in-plugin` WARN into an actual
gate; the naive first-reach invocation without `--strict` is a silent rubber-stamp.

## Capability / path matrix

| Path class | host-loop (file tools) | host-loop (workspace bash) | VM loop (file tools = bash view) |
|---|---|---|---|
| outputs | rw — IS the agent cwd (`artifacts/...` relative) | rw at the host outputs dir bind-mounted at `/sessions/<id>/mnt/outputs` | rw at `mnt/outputs` (cwd `/sessions/<id>`) |
| uploads | read-only (write attempt denied: a task-session upload is a hardlink to the user's original file, so edit the working copy or write under outputs) | read-only mount | read-only mount |
| plugin/skill content | read-only (write attempt denied as "plugin, skill, or knowledge content") | read-only mount | read-only mount |
| spooled tool results (`projects`) | read-only (blocked by the same category guard) | mounted read-only at `mnt/.claude/projects` | staged into the VM's own `.claude` dir |
| connected folders | production default **rw** (rwd only after delete-approval consent); the harness's `mode: r` is a HARNESS EXTENSION for authoring read-only fixtures (bind-mounted `:ro` — Read passes, Write is blocked), and a `rw`/`rwd` folder additionally requires operator consent to run | rw per mount, except a harness `mode: r` folder, which is `:ro` | same — a harness `mode: r` folder is read-only, not rw |
| `/sessions/*` | DENIED (a VM path on a host filesystem) | valid — it IS the sub-agent's namespace | valid — it IS the sub-agent's namespace |
| delete semantics | file tools have no delete verb | `rm` is **not** blocked at the mount by the harness — production denies deletes in outputs/connected folders outright, unblockable except through its own approval flow, but the harness mounts those writable and catches a delete **after the fact** via a post-run scan/assertion; a per-mount delete-deny is separate, not-yet-built work | same post-hoc detection as bash |
| `${CLAUDE_PLUGIN_ROOT}` | pre-resolved into the agent's prompt TEXT at definition load; the literal token is never expanded by file tools; the env var is not present in the Bash-tool subprocess env | same — the env var is absent from the Bash subprocess on the VM loop too | same — pre-resolved in text; env var absent from Bash |

The `${CLAUDE_PLUGIN_ROOT}` row deserves a second read: a plugin's own file references resolve because
the path is substituted into the prompt text when the plugin definition is loaded, not because a
sub-agent's shell inherits an environment variable — no tier ever exposes `CLAUDE_PLUGIN_ROOT` to a
Bash-tool subprocess. See [plugin-root.md](./plugin-root.md) for the full authoring guide (per-tier
staging paths, the host-loop self-heal, and the lint tooling that catches a hardcoded-token footgun in
a skill's shell steps).

## Sub-agent tool composition

A dispatched child's tool set is computed by the agent binary; the harness reproduces that computation
rather than re-deriving its own. What determines a child's tools:

| Rule | Effect |
|---|---|
| explicit `tools:` frontmatter list | a strict allowlist; a tool is included only by exact name or an `mcp__<server>` / `mcp__<server>__*` entry. `Read, Edit, Glob, Grep` excludes workspace bash. |
| `"*"` in a tools list | collapses to inherit-all at parse time — the wildcard surface (every eligible surviving session tool). |
| no `subagent_type` on the dispatch | falls back to the built-in `general-purpose` agent, whose own `tools:` is `["*"]` — the wildcard surface, including workspace bash. See the trap below. |
| `disallowedTools` | applies even against an explicit `tools:` list. |
| `memory:` agents | Read/Write/Edit are force-added even against an explicit `tools:` list — the one allowlist exception. |
| never-subagent tools | a sub-agent can never be given `TaskOutput`, `ExitPlanMode`/`EnterPlanMode`, `AskUserQuestion`, `ConnectGitHub`, `WaitForMcpServers`, `Workflow`, `ScheduleWakeup`, or `EndConversation` — these are main-loop-only regardless of frontmatter. |
| ToolSearch | ON when unset (the agent's default mode); `ENABLE_TOOL_SEARCH=off` or `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` disables it (a "standard" mode name that actually means DISABLED — a naming trap). A 4-tool agent legitimately lacks it (evidence: `mcp_search_unavailable`). Tune it via the harness's `agent_env` session knob. |
| WebSearch | a normal built-in tool; included by the allowlist like any other. |
| MCP additions (`mcpServers:` frontmatter) | the one sanctioned extra-tool channel for a custom agent — but **plugin-shipped agents cannot use it**: the loader discards a plugin agent's `mcpServers`/`permissionMode`/`hooks` at load time. |
| tool aliases | host-loop only: `Bash → mcp__workspace__bash`, `WebFetch → mcp__workspace__web_fetch`, single-hop. An alias never GRANTS a tool — a bare `Bash` in frontmatter resolves only when `mcp__workspace__bash` is already in the child's bound set. VM tiers set no aliases (their `Bash`/`WebFetch` are the literal built-in tools). |
| pre-approval | host-loop pre-approves `mcp__workspace__bash` for the whole session (no permission gate ever fires for it); `web_fetch` still routes through the normal permission gate — one recorded decision, matching production's shape. |

## Cross-tier sub-agent deltas

- **Loop selection.** The host-loop gate is force-ON first-party today — host-loop IS the production
  default. A resumed session keeps whichever loop it started with.
- **Bash.** Host-loop sub-agents inherit the session-wide pre-approved `mcp__workspace__bash` (no
  permission gate ever fires for it); VM tiers bind the literal `Bash` tool instead.
- **Path gate.** Host-loop only. VM tiers have no path gate — containment there comes from the mount
  topology, not a PreToolUse check.
- **Environment append.** Host-loop children get the host-loop sub-agent environment text (host cwd
  framing for file tools, VM root framing for the bash mount); VM children get the VM-loop equivalent
  text; the `protocol` tier sends neither — see
  [fidelity-gaps.md](./fidelity-gaps.md#protocol-tier-sub-agents-get-no-cowork-environment-append) for
  why, and for the excluded fork/`useExactTools` dispatch path (excluded on the agent's own side; the
  harness does not and must not re-implement that exclusion logic host-side).
- **cwd.** A sub-agent inherits the parent's cwd — the `Task` tool's own input schema has no `cwd`
  field, so a model can never set a child's working directory directly.

## The type-less dispatch trap

A `Task` dispatch WITHOUT `subagent_type` falls back to the built-in `general-purpose` agent
(`tools:["*"]`) — the wildcard surface includes every eligible surviving session tool, including
workspace bash. This is faithful production behavior, and it fires routinely in real usage, not just
as an edge case. The frontmatter `tools:` allowlist on a NAMED agent is still strictly enforced (MCP
tools included only by exact name or an `mcp__<server>`/`mcp__<server>__*` entry) — it's only the
type-less path that falls through to the wildcard.

Defenses:
- pin `subagent_type:` literally in dispatch instructions rather than leaving it to the model to infer;
- assert `subagent_dispatched` together with `subagent_tool_absent` on the tools the dispatch should
  never have reached;
- the harness warns loudly whenever a dispatch omits `subagent_type` (an *explicit*
  `subagent_type: "general-purpose"` is a deliberate author choice and does not warn), and records the
  omission on the run (`subagents[].dispatchTypeOmitted`) so it shows up in the run's own record, not
  only in a live terminal warning.

## Sub-agent identity, model, and environment

- **No per-sub-agent process; no per-sub-agent env vars.** A Task sub-agent runs in-process with the
  parent — its identity is carried as context fields surfaced to hooks as JSON input (an agent id and
  agent type), never as environment variables. A Bash subprocess a sub-agent spawns sees only a
  generic marker identifying it as agent-driven, not the agent id/type, and not `CLAUDE_PLUGIN_ROOT`.
- **Model resolution defaults to inheriting the main-loop model.** Precedence, highest first: an
  operator/session `CLAUDE_CODE_SUBAGENT_MODEL` env override (unless it is the `"inherit"` sentinel) →
  the `Task` tool's own `model:` dispatch parameter → the agent's frontmatter `model:` → inherit the
  main-loop model (the default when none of the above apply). Real Cowork only sets that env override
  when a concrete, non-`"inherit"` default is configured server-side — so **by default a Task
  sub-agent runs the same model as the main loop**, overridable per-session, per-dispatch, or per-agent
  frontmatter. The built-in `Explore` agent inherits too, except when the main model falls outside the
  small/mid/large model family, where it pins to the largest; built-in teammate-style agents default to
  the largest model. The harness's `agent_env` session knob sets the override env uniformly across
  tiers.

## Lifecycle / resume / fan-out

- **One-shot per call.** The `Task` tool's schema carries `description`, `prompt`, `subagent_type?`,
  `model?`, `run_in_background?`, `isolation?` — there is no `resume`/`agentId` field. Cowork severs
  sub-agent resume at spawn; you cannot hand a live conversation back to a previously dispatched child.
- **Background dispatch is stripped in Cowork.** `run_in_background` defaults ON in the underlying
  agent, but Cowork sets an environment flag that strips `run_in_background` from the tool's schema
  entirely, so Cowork's Task children are foreground one-shots (a second flag disables the separate
  "agents fleet" surface too). A cross-session continuation mechanism exists for agent-type sessions,
  but it is not sub-agent resume — don't conflate the two.
- **Nesting depth is capped at 5; fan-out per call is not capped.** Exceeding the depth cap throws
  hard. There is no limit on how many `Task` calls one turn can make — only the generic tool-scheduler
  concurrency window (which queues excess calls rather than refusing them). Any "at most 5 agents"
  wording you may see in UI copy is a tip, not an enforced limit; a "workflow size" hint some skills
  inject is prompt guidance, not a hard cap either.
- **Fork exclusion is the agent's own logic.** Fork/`useExactTools` dispatches are excluded from the
  sub-agent environment append by the agent binary itself, and that exclusion propagates to any nested
  sub-agents a fork spawns — the harness documents and tests this, it does not re-implement it
  host-side.

## Assertion semantics — read before writing a "shell-free" policy

`subagent_tool_absent` matches ATTEMPTED tool names (recorded at the tool-use event, before any
result) — it proves "no matching attempt was made," not capability absence and not the absence of a
side effect. Capability absence is enforced upstream, by the explicit `tools:` allowlist itself.

Glob matching is case-sensitive, and that has a cross-tier consequence: `mcp__workspace__*` covers
host-loop's `bash` and `web_fetch` but does **not** match the VM tiers' literal `Bash` tool — a
cross-tier "no shell" policy needs both patterns. Likewise, "no file writes" needs its own explicit
`Write`/`Edit`/`MultiEdit`/`NotebookEdit` (and any write-capable custom MCP tool) absence checks — none
of the shell-absence patterns implies it.

See also [boundary.md](./boundary.md) for the tier-by-tier boundary model these sub-agent rules sit on
top of, and [scenario.md](./scenario.md) for the `subagent_*` assertion reference.

## Observing mechanics cheaply

Sometimes you don't want to judge a skill's *analytical* output — you want to see whether it walks the
right *steps*: does it dispatch the sub-agent it's supposed to, with a typed `subagent_type`; does it
write to the outputs mount instead of a denied `/sessions/...` path; does the step sequence even reach
the point that matters. That's plumbing, not quality, and you can inspect it without paying for an
expensive model.

**First line — static, token-free, no run at all.** Run
[`analyze-skill`](#static-path-fidelity-check-analyze-skill) first. It catches the whole `/sessions`-path-to-file-tool
defect class from the SKILL.md text alone, before spending anything on a live run.

**Second line — a cheap live run, for what static analysis can't see.** Point both loops at a cheap
model and read the telemetry a run already produces:

- Main loop: `--model <cheap-id>` on `cowork-harness skill <dir> "<prompt>" --model <cheap-id>` or
  `cowork-harness run <scenario.yaml> --model <cheap-id>`. A session YAML's `model:` field does the
  same for a checked-in scenario, and `run --matrix`'s `models:` axis sweeps it across cells.
- Sub-agents (if the skill dispatches any): `agent_env.subagent_model: <cheap-id>` in the session YAML
  — sets `CLAUDE_CODE_SUBAGENT_MODEL` uniformly across tiers, independent of the main-loop model (see
  [Sub-agent identity, model, and environment](#sub-agent-identity-model-and-environment) above).

Then inspect the run dir's plumbing telemetry — `fileToolAttempts` (with origin), `pathDenials`, and
`subagents[].resolvedAgentType` / `dispatchTypeOmitted` in `result.json` — none of which depend on
model quality to be meaningful; a denied path or an untyped dispatch shows up the same way regardless
of which model produced it. The matching assert keys turn that telemetry into a pass/fail: `no_vm_path_file_op`,
`path_denied` / `vm_path_denied`, `subagent_dispatched`, `subagent_dispatch_healthy`.

**The honest limit.** There is no `--driver=scripted` or forced step-sequencer in the harness — a cheap
model still has to read the skill and decide to walk its steps *unassisted*. If the model is too weak
to follow the skill at all, it may never reach the step whose plumbing you wanted to observe, and the
telemetry above will simply be absent or empty rather than showing a failure. This recipe observes
plumbing **when the model gets there**, not on a deterministic schedule — pick the cheapest model that
still reliably follows the skill's steps, not the absolute cheapest one available.

## Stream observability — where the sub-agent + path telemetry comes from

`RunResult`'s sub-agent and path fields aren't inferred after the fact — each is derived from a specific
event on the child→driver SDK stream (`events.jsonl`). This section names those wire channels so a
consumer knows what's actually being observed, and what isn't.

**Dispatch identity — the `task_started` event family.** A `subagent_dispatch` event is synthesized the
moment the parent stream emits a `tool_use` block named `Agent`/`Task` (or carrying `subagent_type` in
its input) — this seeds `subagents[].dispatchAgentType` (the DISPATCH-INPUT type) and
`dispatchTypeOmitted`. The BINARY-**resolved** child type arrives separately, as a system-subtype event:
`task_started`, one member of a sibling family the harness tracks as a group (`task_started`,
`task_progress`, `task_updated`, `task_notification`, `background_tasks_changed`, `thinking_tokens` —
`src/run/run.ts:37-44`). Only `task_started` is consumed today: joined strictly by `tool_use_id`
(`src/run/run.ts:830-849`), it sets `subagents[].resolvedAgentType` — "strictly better evidence than
`dispatchAgentType` for a type-less dispatch" (`schema/run-result.json:662-664`) — and when a dispatch
had `dispatchTypeOmitted` and resolved to `general-purpose`, the harness warns loudly about the
wildcard-fallback trap (see [The type-less dispatch trap](#the-type-less-dispatch-trap) above).

**Resolved model and output — the `toolUseResult` envelope / `subagent_result_meta`.** The child's `user`
message carrying its `tool_result` also carries a TOP-LEVEL sibling field on the raw frame,
`tool_use_result` (`src/agent/session.ts:1034-1038`) — the wire's `toolUseResult` envelope. When it
carries `resolvedModel`/`agentType`/`status`, the harness parses it into a `subagent_result_meta` event
(`src/agent/session.ts:1049-1056`), joined by the paired `tool_result` block's `tool_use_id`. That event
feeds `subagents[].resolvedModel` directly, and only *corroborates* `resolvedAgentType` — it never
overwrites stronger evidence `task_started` already set (`src/run/run.ts:742-748`). `subagents[].output`
comes from the same `user` message, but a different content block: the `tool_result` block itself (a
separate `tool_result` event, `src/agent/session.ts:1064-1078`), joined by the dispatch's own `toolUseId`
against `RunResult`'s `toolResults` (`src/run/run.ts:1071-1081`, `denormalizeSubagentOutputs`) — the
dispatch's own return value, capped at the assert-text cap (`outputTruncated` records when the cap
actually cut something, so `subagent_output_contains` reports "unverifiable" rather than a false
negative). `subagents[].toolsUsed` is **not** part of this envelope — see parent-stream attribution below.

**Path denials and attempts — `permission_denied`, the PreToolUse hook, and `can_use_tool`.**
`pathDenials[]` has exactly three filtered producers (`schema/run-result.json:97`):

1. `pretooluse` — the PreToolUse path gate's own hook callback (`HOSTLOOP_PATH_GATE_ID`) firing `block`
   (`src/run/run.ts:888-910`); host-loop only.
2. `can_use_tool` — a DENIED `can_use_tool` ask on a gated file tool that carries a path
   (`src/run/run.ts:1225-1240`) — covers every decider (scripted, parity default, the host-loop gate, or
   a human).
3. `permission_denied` — a stream `permission_denied` system event, ingested ONLY when correlated by
   `tool_use_id` to an already-recorded `fileToolAttempts` entry that itself carries a path
   (`src/run/run.ts:855-877`) — a real `permission_denied` can fire for a non-path tool too (e.g.
   `present_files`), so it is never ingested unfiltered.

`fileToolAttempts[]` feeds the correlation above and stands on its own as attempt-level (not
decision-level) telemetry: every gated file-tool `tool_use` — `Read`/`Write`/`Edit`/`Glob`/`Grep`/
`MultiEdit` (`FILE_ATTEMPT_TOOLS`, `src/run/run.ts:25`) — is recorded regardless of outcome, with
`origin: "main" | "subagent" | "unknown"` set from the same recognized-dispatch membership check the
attribution branch below uses (`src/run/run.ts:571-588`).

**Parent-stream attribution, and the thinking gap.** A child's `tool_use`/`text` blocks carry a block- or
message-level `parent_tool_use_id` (`src/agent/session.ts:946-966`), threaded onto the synthetic
`tool_use`/`assistant_text` events as `parentToolUseId`. The recorder uses it to attribute a tool call to
the dispatch whose `toolUseId` it matches (`src/run/run.ts:635-648`) — this is the sole channel behind
both `subagents[].toolsUsed` and the newer `subagents[].referencesRead` (skill reference/script files
*that sub-agent* Read, same `skillReferenceReadPath()` predicate the main-agent `referencesRead` uses,
deduped in first-seen order).

HONEST LIMIT, scoped to the **parent SDK stream**: `thinking` blocks arriving on THAT stream are parsed
**without** a `parentToolUseId` at all. Compare `src/agent/session.ts:967` (`text` → `assistant_text`,
threads `parentToolUseId`) and `:969` (`tool_use`, threads it) against `:968` (`thinking` — does not);
the synthetic event type itself has no `parentToolUseId` field on `thinking` (`src/agent/session.ts:94`).
So even where a sub-agent's own reasoning could in principle land on the parent stream, the harness has
no key to attribute *that copy* to a dispatch — `RunResult.thinking` is populated unconditionally at the
top level (`src/run/run.ts:716-719`) and is never scoped to a `subagents[]` entry from this channel. This
is still true and unchanged — **a consumer must not expect the top-level `thinking[]` field to carry
attributable sub-agent reasoning**, an SDK limitation upstream of the harness, not a harness omission.
It does **not** mean sub-agent reasoning is uncaptured altogether — see the next subsection.

### `subagents[].reasoning` — the on-disk child-transcript channel (new in 0.31.0)

The parent-stream gap above is closed by a **separate** channel that doesn't depend on
`parentToolUseId` at all: the on-disk child session transcript the agent binary itself writes per
`Task` dispatch, `<configDirRoot>/projects/**/subagents/agent-<id>.jsonl`
(`src/run/subagent-reasoning.ts`). At finalize (after `assembleRunResult`, before `result.json` is
written), `captureSubagentReasoning` walks `<configDirRoot>/projects/**/subagents/` for every
`agent-*.meta.json`, reads its `toolUseId`, and joins it to the matching `subagents[]` entry by an
**exact** `toolUseId` match — no path reconstruction from the projSlug/parentSessionUUID segments.
The sibling `agent-<id>.jsonl` is then parsed into ordered `{kind: "thinking"|"text", text}` turns
(`tool_use`/`tool_result` blocks excluded — already covered by `toolsUsed`/`referencesRead`) and
written to that dispatch's `subagents[].reasoning`.

- **LIVE/record lane only** — the child transcript exists only while the real agent binary ran, so
  `reasoning` is `undefined` on replay, same as `resources`/`mcpErrors`.
- **Capped like the top-level `thinking[]` field** — the same 50-entry / 10KB-per-entry convention
  (`REASONING_CAP`/`REASONING_TEXT_CAP_BYTES`, intentionally identical values to `Run.THINKING_CAP`/
  `Run.THINKING_TEXT_CAP_BYTES` but separate constants), with `reasoningElided` counting turns pushed
  out past the cap (only present when non-zero).
- **`configDirRoot` is fidelity-tier-resolved** — hostloop vs. the container/microvm sandboxed config
  dir; an unresolvable root (e.g. `protocol`) leaves `reasoning` undefined on every dispatch.
- **Never fails the run.** A missing/malformed child transcript, an unreadable `configDirRoot`, or a
  meta file with no matching `subagents[]` entry is a silent per-dispatch no-op — `reasoning` just
  stays `undefined` for that dispatch (distinct from `[]`, which means a child file WAS found but
  produced no thinking/text turns).

**Sub-agent thinking TEXT is empty by default — only TEXT turns carry content.** This is the most
important semantic to understand before consuming `reasoning`. A sub-agent thinking block comes through
with an **empty `thinking` string but a non-empty cryptographic `signature`** (the continuation token),
so a `thinking` turn is surfaced as `{ "kind": "thinking", "text": "", "redacted": true }`. The harness
adds the `redacted: true` marker precisely so a consumer does **not** misread empty text as "the
sub-agent didn't reason":

| Shape | Meaning |
| --- | --- |
| `{ "kind": "thinking", "text": "", "redacted": true }` | The sub-agent **reasoned here, but the text was omitted by request** (signature present, thinking text empty). Default state on this surface. |
| `{ "kind": "thinking", "text": "<content>" }` | Thinking text that *was* returned (no `redacted` key). Not seen with the default config, but the shape is honored if the display mode is ever changed (see below). |
| `{ "kind": "text", "text": "<content>" }` | A visible TEXT turn (the receipt/output the sub-agent SAID) — **always captured verbatim**, never redacted. |
| `reasoning: []` | A child transcript was found but had no thinking/text turns at all. |
| `reasoning: undefined` | No child transcript joined (replay, or a tier this wasn't captured on). |

  **Why it's empty (mechanism).** This is **not** the binary stripping text when it writes the
  transcript — it is a **request-side display mode**. The API's `thinking.display` is forced to
  `"omitted"` for a sub-agent turn whenever the session is non-interactive (the harness always spawns
  `-p`) and no explicit display was set, so the model returns empty thinking blocks (signature-only)
  that the child transcript then faithfully records. Binary-verified against the staged 2.1.205 agent;
  corpus-corroborated: 230/230 sub-agent thinking blocks were text-empty-but-signature-present, while
  the *same agent binary's* main-loop transcripts — which resolve `display` to the API default
  (`"summarized"` on Sonnet-4.6) — keep 1810/1827 blocks with full text. The signature is opaque (not a
  reversible encoding of the text), and the same-run parent event stream drops sub-agent thinking too
  (SDK-suppressed, per the previous subsection), so with the default config the text is unrecoverable.

  **Is there a lever?** Yes, but it is **opt-in and fidelity-diverging**. The fenced
  `debug.thinking_display: "summarized"` session field (see [session.md](./session.md)) emits the agent
  binary's `--thinking-display summarized`, which surfaces **summarized** thinking for both loops.
  Live-verified with a matched hostloop A/B on opus-4-8: the default run's thinking blocks were
  empty-but-signed on both loops, while the `summarized` run's carried real text (sub-agent ~189 chars,
  main-loop ~242). Note the ceiling: the API returns **no raw chain-of-thought** — `display` is only
  `summarized` | `omitted`, so "summarized" is the maximum for *either* loop, not the verbatim CoT. Real
  Cowork passes no such flag, so the default `"omitted"` is the fidelity-faithful behavior; summarized is
  a **debug opt-in**, not the default. **The
  same is true of the top-level `thinking[]` field (the main loop):** on models that default `display`
  to `"omitted"` (Opus 4.8, Sonnet 5 — verified empty in the corpus, vs. Sonnet-4.6 which defaults to
  `"summarized"`), `thinking[]` fills with `{text:"", redacted:true}`, carrying the identical `redacted`
  marker so a consumer never misreads it as "no reasoning." The fenced `debug.thinking_display:
  "summarized"` opt-in flips both loops to summarized text at once. `redacted` is omitted (not `false`)
  on turns/blocks that carry text.

**Where to look.** `schema/run-result.json` is the authoritative field reference — every field named
above has a `description` there (`subagents[]` at line 640; top-level `fileToolAttempts`/`pathDenials` at
lines 61/80). The matching assert keys (see [scenario.md](./scenario.md)) turn this telemetry into
pass/fail: `subagent_dispatched` (matches `dispatchAgentType`/`resolvedAgentType`/description),
`subagent_dispatch_healthy` (per-dispatch delivered output + no VM-path attempts, host-loop only),
`no_vm_path_file_op` (content-class, re-derived from the frozen `tool_use` stream — replay-checkable
without `controlOut`), and `path_denied` / `vm_path_denied` (decision-level — need `controlOut` on
replay).
