# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses
[Semantic Versioning](https://semver.org/); pre-1.0 minor versions may include breaking changes.

## [0.1.0] — 2026-06-16

Initial public release. A faithful, headless, scriptable harness for Claude Cowork's runtime — for
testing Claude Code **skills** outside the Desktop app with the same staged agent, spawn/control-protocol
contract, egress allowlist, permission protocol, and sandbox limitations. Binary-grounded against
`app.asar` 1.12603.1 / agent ELF 2.1.170.

### Added

- Commands: `skill`, `run`, `chat`, `record`, `replay`, `trace`, and `decide`, plus `sync`,
  `boundary-check`, and `vm` management. Stable `--output-format json` envelope and CI-ready exit codes.
- Five fidelity tiers (`fidelity:`): `protocol`, `container`, `microvm`, `hostloop`, and `cowork`
  (auto-picks host-loop vs container the way Cowork does).
- Scenario YAML — prompt + scripted answers + `assert:` (transcript, files, artifacts, tool / sub-agent
  usage, egress, and more) for authored, asserted regression runs.
- Input policy with no silent false-greens: scripted, LLM, and in-band (`--decider-dir`) answering for
  AskUserQuestion / tool-permission gates; an unanswered gate fails loud.
- Default-deny egress sandbox enforced against the synced Cowork domain allowlist.
- Token-free, Docker-free cassette `record` / `replay` for the PR gate.
- Platform baselines synced from a local Claude Desktop install — nothing Anthropic-owned is bundled
  or distributed.
