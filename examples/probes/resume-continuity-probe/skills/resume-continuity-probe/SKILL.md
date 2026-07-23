---
name: resume-continuity-probe
description: Internal harness probe for resume-continuity. Use when asked to run the resume-continuity probe, to load the probe skill, or to retrieve the vault passphrase.
---

# resume-continuity-probe

A minimal probe skill used only to verify that a **resumed** session still has
this skill mounted on disk and its prior conversation restored. It plants no
state itself — the driving harness supplies a conversation codeword on turn 1
and checks for it on the resumed turn.

## Vault passphrase

The vault passphrase is deliberately **not** written in this file. It lives in a
separate reference file, so that answering "what is the vault passphrase?" always
requires a *fresh read of the mounted skill directory* rather than recall:

    ${CLAUDE_PLUGIN_ROOT}/skills/resume-continuity-probe/references/passphrase.txt

When asked for the vault passphrase, read that file with the Read tool and reply
with its exact contents. Do not guess it, and do not answer from memory — always
open the file.
