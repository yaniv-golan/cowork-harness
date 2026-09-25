# The companion skill

Install and orientation for the `cowork-harness` companion skill — the thing that lets Claude Code
drive the harness for you, instead of you typing CLI commands.

**This page is install-only.** The canonical *usage* reference is the skill itself
([`SKILL.md`](../.claude/skills/cowork-harness/SKILL.md) and its `references/`), which is what an agent
loads when it invokes the skill.

- **Running the CLI by hand instead?** → [docs/cli.md](./cli.md)
- **Wiring it into CI?** → [docs/ci.md](./ci.md)

---

## Install

This repo ships a **companion skill** (`.claude/skills/cowork-harness/`) that teaches an agent how to drive the harness — author scenarios, pick a fidelity tier, script answers, place assertions in the right CI lane, and avoid the "✓ passed ≠ correct" traps. **This is independent of the CLI install above** — `npm install -g cowork-harness` puts the CLI on your `PATH` but does not register anything with Claude Code; to use the skill *inside* Claude Code, install it separately via the bundled marketplace, either as slash commands in an interactive session:

```text
/plugin marketplace add yaniv-golan/cowork-harness
/plugin install cowork-harness@cowork-harness
```

or their shell equivalents (e.g. in a non-interactive setup script):

```bash
claude plugin marketplace add yaniv-golan/cowork-harness
claude plugin install cowork-harness@cowork-harness
```

The skill **self-bootstraps the CLI**: if `cowork-harness` isn't on your PATH it falls back to `npx "cowork-harness@^3.9.0"` (a version floor that fails loud rather than silently fetching a too-old CLI; Node ≥ 22). Tiers above `protocol` still need Docker/Lima and a Claude Desktop agent binary — see the prerequisites below.

It also follows the open [Agent Skills](https://agentskills.io) spec, so it installs cross-editor (Cursor, Codex, OpenCode, …) via [`npx skills`](https://github.com/vercel-labs/skills) (Vercel Labs' CLI implementation of that spec):

```bash
npx skills add yaniv-golan/cowork-harness --skill cowork-harness
```

(Working *inside* this repo, the skill auto-loads as a project skill — no install needed.)

**What the marketplace install actually pulls:** only `.claude/skills/cowork-harness/` — SKILL.md +
`references/` + `scenario.py`/assertion keys, per `.claude-plugin/marketplace.json`'s `source`. Everything
else (the CLI, `docs/`, the worked examples, the pytest lane) arrives when the skill's first command
self-bootstraps `npx "cowork-harness@^3.9.0"`, which pulls the same npm package as a global install.

For the full package-contents table — what a global install gives you versus a source checkout — see
[docs/cli.md → What ships](./cli.md#what-ships). It is maintained there, once.

