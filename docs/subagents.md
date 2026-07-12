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

`cowork-harness analyze-skill <SKILL.md | skill-dir/>` catches the "hands a `/sessions/...` path to a
file tool" defect described above **statically**, token-free — no Docker, no model call, no live
host-loop run — by scanning a SKILL.md's text. It reuses the harness's own ported `/sessions` path-gate
predicate (`isVmSessionsPath`) as the DENY decision; the only heuristic part is extracting candidate
paths out of markdown text. Two WARN rules, both exit-1 findings:

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

**Context confidence governs which guards apply.** HIGH-confidence STRUCTURED contexts — an
`OUTPUT_PATH=`/`OUTPUT_DIR=` assignment, a `Write(`/`Read(`/`Edit(`/`Glob(`/`Grep(` directive target, and a
bare `/sessions/...` path LINE inside a dispatch construct — are machine-unambiguous and fire regardless of
a neighboring anti-instruction word or a stray "bash" mention elsewhere on the line: an author writing
`Write(/sessions/...)` next to "Do not modify any other file." is still handing a `/sessions` path to a
file tool. Only the LOW-confidence PROSE idiom ("write/save/read/edit ... to/at `/sessions/...`") keeps
the negation guard and the bash-tool suppression, since that context is the one where a genuine
remediation ("Use the bash tool to write ... to `/sessions/...`") or an anti-instruction ("Never write to
`/sessions/...`") is ambiguous without them.

**EXEMPT by design** (false-positive guards, deliberately conservative — "when unsure, do not flag"):
a `/sessions` token inside a ` ```bash `/`sh`/`shell`/`zsh`/`console`/`*-session` fenced block (matched by
exact language name, not a prefix — a ` ```shiny ` fence is not bash-ish just because it starts with "sh"),
or the same fence blockquoted with `> `, is legitimate in-VM bash and is never scanned; the fence opener's
language is read as the first word only, so a trailing info-string (` ```bash title="x" `) doesn't defeat
the exemption and doesn't leave a phantom fence open for later content to cascade into; a 4-space/tab
INDENTED unfenced block is treated the same way UNLESS the run of indented lines carries a dispatch marker
(`Task(`/`subagent_type`), in which case it is analyzed like a fenced dispatch block instead (see "Honest
limits" below); a line carrying an anti-instruction word (`never`, `don't`, `do not`, `avoid`, `not`) on
that line OR the immediately adjacent line suppresses ONLY the prose context, not a structured one (see
above); a line mentioning the `bash` tool in the CLAUSE that links the verb to the path (not merely
anywhere on the line) suppresses the prose context — an unrelated, punctuation-severed earlier clause
naming "bash" does not suppress a genuinely different instrument; passive-voice documentation prose
("Deliverables are saved at ...", "Uploads are read-only at ...") does not count as an imperative
instruction; plain prose that documents a fact (e.g. "the VM cwd is `/sessions/<id>`") without any of the
positive contexts above is left alone. A token that matches more than one positive context on the same
line (e.g. an `OUTPUT_PATH=` line that also sits inside a dispatch-construct fence) is reported once, not
once per matching context.

**Honest limits.** Only the extraction is heuristic — the deny decision is the same one production
enforces. Documented false negatives: a variable-carried path (`$OUT/...` where the literal value isn't
`/sessions`), a `/sessions` path written only in an INDENTED (4-space/tab) unfenced code block that does
NOT carry a dispatch marker — treated as an exempt code context, the same as a fenced bash block, since an
unfenced VM-bash template written this way is legitimate in-VM bash, not a violation. An indented block
that DOES carry a dispatch marker (`Task(`/`subagent_type`) is NOT exempt — it is analyzed the same way a
fenced dispatch block is, since an indented dispatch template is this analyzer's headline defect class,
not VM bash. Also a documented false negative: a prose-only dispatch instruction (no fenced or indented
block). Two decision-class misses are out of v1 scope entirely: an absolute HOST path outside connected
folders (denied by containment, not the `/sessions` rule) and a write into a read-only category
(uploads/spool/plugin content) — neither is a `/sessions` finding, so this analyzer doesn't claim to
catch them.

**`analyze-skill` gates the HOST-LOOP path model only.** A skill authored exclusively for a VM tier
(`container`/`microvm`), where `/sessions` is a valid, ungated path, is not what this analyzer is meant to
clear — a clean result there isn't meaningful, and a firing result on such a skill is a false alarm for
that tier (the finding message names the tier explicitly so this is visible at read time, but `analyze-skill`
itself has no way to know which tier(s) a given SKILL.md targets). Run it against skills meant to work
on host-loop, or skills written to work across tiers via the tier-qualified addressing above.

**A clean `analyze-skill` is a PRE-FLIGHT signal, not proof of on-tier resolution.** The authoritative
check remains the runtime `no_vm_path_file_op` / `vm_path_denied` assertions (see
[scenario.md](./scenario.md)) against a real recorded/live run — `analyze-skill` exists to catch the
obvious cases before paying for that run, not to replace it.

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
