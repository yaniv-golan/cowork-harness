<!--
PARAPHRASED reconstruction of the host-loop sub-agent environment SECTION (section key
`subagent_env_hl`) — the branch the generator selects when hostLoopMode is true.
Binary-verified against app.asar 1.46388.3; hl branch fingerprint 464ecc87a6810941 (the `vm` branch is
unchanged at 859aa136fc15b38f and keeps its own 1.15200.0 asset).

Supersedes the 1.32885.1 asset, which was faithful from 1.32885.1 through 1.44121.1. Desktop 1.46388.3
did NOT append to that text — it REPLACED it, and this file is correspondingly shorter than its
predecessor. That is not a trimmed paraphrase: the material that left this section did not leave the
product, it moved OUT of the overridable unit.

WHAT THIS FILE IS NOT. Through 1.44121.1 this asset was the whole host-loop append. It is not any
more. Production composes three parts, and only the FIRST is this file:

  1. this section — the only part a server-delivered `spSectionPrompts` entry can override;
  2. a folder manifest, host-loop only, built from live mount state (outputs dir + every attached
     folder with its host<->shell mapping, or a different sentence when there is nothing to list);
  3. one sentence about invoking skills, appended unconditionally to BOTH branches.

Parts 2 and 3 are GENERATED, in `src/prompt/subagent-manifest.ts`, because part 2 is built from
per-session state that no static file can be faithful to — the same reason the main-loop shell section
became a generator at Desktop 1.14271.0. Do not "restore" them here: an asset copy would be rendered
in addition to the generated text, not instead of it. Their drift is guarded by the `manifest` and
`suffix` fingerprint axes.

Semantics preserved, wording deliberately not verbatim (public repo, no-bundling rule); drift in the
section itself is guarded by the sync-side two-branch fingerprint sentinel.

Tokens: {{vmCwd}} = the VM session root `/sessions/<id>`. Note that unlike its predecessor this
section no longer names the HOST working directory at all — `{{cwd}}` moved into the generated
manifest's relative-paths clause, which is where production now states it.
-->
## Cowork environment

Your shell tool, `mcp__workspace__bash`, runs on Linux and starts out in `{{vmCwd}}`. Anything it
writes outside `{{vmCwd}}/mnt/` — `/tmp` included — is not visible to the user, and your file tools
cannot see it either.
