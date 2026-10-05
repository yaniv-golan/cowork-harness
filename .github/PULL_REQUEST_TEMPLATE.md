<!-- Thanks for contributing! Keep PRs focused. -->

## What & why

<!-- What does this change and what problem does it solve? Link issues. -->

## Checklist

- [ ] `npm run ci` passes (typecheck · test · build)
- [ ] `npm run format:check` passes
- [ ] Added/updated unit tests for new schema fields, `Decider` rules, or egress logic
- [ ] Shipped examples still validate (`test/examples.test.ts`)
- [ ] If I touched the sandbox (`runtime/container.ts`, `docker/`, `boundary.ts`): boundary model is unchanged or `boundary-check` + docs updated
- [ ] If release-specific: changed `baselines/*.json` via `sync`, not hard-coded in source
- [ ] Unverified-against-live-agent code is marked `// UNVERIFIED`
- [ ] Updated docs / CHANGELOG as needed

## Companion skill (required)

<!-- One line, either "updated: <files>" or "not affected: <reason>". A behaviour change counts, not only a new
     name: a changed refusal, exit code or default, or a change to what a flag unlocks, makes the skill passages
     describing the old behaviour stale (.claude/skills/cowork-harness/SKILL.md and references/*.md). -->

Companion skill:

## Fidelity / boundary impact

<!-- Does this change what the harness reproduces vs. real Cowork? Note any new gaps. -->
