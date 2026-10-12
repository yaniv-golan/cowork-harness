---
name: resumable-probe
description: A synthetic gated skill that parks at a gate and resumes from its own status file in a later session. Use only when asked to run the resumable probe.
---

# Resumable probe

Nobody answers questions in this session: never ask the user anything.

1. If the request contains `ANSWER g1=<option>`, run
   `python3 "${CLAUDE_PLUGIN_ROOT}/skills/resumable-probe/scripts/run.py" --answer <option>` with Bash.
   Otherwise run `python3 "${CLAUDE_PLUGIN_ROOT}/skills/resumable-probe/scripts/run.py"` with Bash.
2. If the script exits 12, the run is waiting at a gate: say in one sentence that it is waiting, and stop.
   Do not ask the question, and do not change the status file yourself. A later session resumes from it.
3. If the script exits 0, say the run is complete, and stop.
