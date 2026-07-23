---
name: subagent-research-probe
description: Live-lane probe — dispatches one sub-agent that must research with the WebSearch tool.
---

# subagent-research-probe

When asked to research: dispatch exactly ONE Task sub-agent (subagent_type: general-purpose) and
instruct it to use the **WebSearch tool** to answer the question, then report its one-sentence answer
back verbatim. Do not search yourself; the sub-agent must do the searching.
