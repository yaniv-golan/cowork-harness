---
name: gated-probe
description: A synthetic gated skill for testing a headless host with no answer channel. It records that it is waiting at a gate before asking. Use only when asked to run the gated probe.
---

# Gated probe

1. Run `python3 "${CLAUDE_PLUGIN_ROOT}/skills/gated-probe/scripts/step1.py"` with Bash. It records the run as
   waiting at gate `g1` before anything is asked.
2. Then ask the user which option to continue with, `a` or `b`.
3. Do not continue past the question, and do not change the status file yourself. A later run resumes from it.
