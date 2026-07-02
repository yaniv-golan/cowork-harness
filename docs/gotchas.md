# Setup troubleshooting FAQ

- **`lint` exits 127.** `python3` isn't on `PATH`. Install it or point `PYTHON` at an interpreter.
- **A local skill folder mounts empty.** Untracked files are invisible to the mount — `git add` the skill
  first (see [README → Test a local skill in one command](../README.md#test-a-local-skill-in-one-command)).
- **`docker build` fails or the agent won't start on Apple Silicon.** Confirm `--platform linux/arm64` is in
  your `docker build` invocation and that Docker Desktop's VM is arm64, not Rosetta-emulated.
- **A git worktree can't find your token.** A worktree's `./.env` is gitignored and absent there even if the
  main checkout has one. Point at it: `cowork-harness --dotenv <path-to-main-checkout>/.env <cmd>`, or run
  `doctor` — it detects this and prints the exact remedy.
- **A live run hangs with no egress activity.** Check the egress-proxy container actually started
  (`docker ps` for `cowork-egress-proxy`); a race on first run can leave it building while the agent already
  attempted a request. Re-run once the image is built (`doctor --tier container` reports proxy-image status).

For the false-green ("✓ passed ≠ correct") landmine catalog, see
[SKILL.md → Gotchas](../.claude/skills/cowork-harness/SKILL.md#gotchas--the--passed--correct-landmines) or
[debugging.md](./debugging.md#the-run-was-green-but-you-dont-trust-it--hunt-the-false-green).
