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

## Fidelity / boundary impact

<!-- Does this change what the harness reproduces vs. real Cowork? Note any new gaps. -->
