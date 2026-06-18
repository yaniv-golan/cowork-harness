# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/yaniv-golan/cowork-harness/security/advisories/new) rather than a public issue. We aim to acknowledge within 5 business days.

## Scope and threat model — read this first

This project is a **test harness**, and its sandbox is a **fidelity fixture, not a security boundary**. Understanding the distinction matters:

- The harness reproduces Claude Cowork's *limitations* (sealed host filesystem, default-deny egress, MCP-only cross-boundary communication) so that a skill which passes a scenario here is constrained the same way it would be in real Cowork. This is about **catching false passes**, not about containing adversaries.
- The `container` tier uses OS containers. Containers are a real isolation boundary for **trusted code under test**, but they are *not* a hardened boundary against **deliberately malicious** code (container escapes exist). Do **not** run untrusted, adversarial skills against real credentials at the `container` tier.
- For untrusted-isolation testing, use the `microvm` tier (a real VM — Apple Virtualization.framework via Lima, macOS arm64 only), which provides VM-grade isolation comparable to Cowork itself.

### Practical guidance

| You are… | Use | Why |
|---|---|---|
| Testing your own skills' behavior + constraints | `container` (default) | Faithful + CI-native |
| Testing isolation of untrusted/3rd-party skills | `microvm` | VM-grade escape resistance |
| Fast logic-only iteration | `protocol` | No sandbox — boundary assertions are refused to avoid false passes |

### Credentials

- Provide the auth token (`CLAUDE_CODE_OAUTH_TOKEN`, preferred) or `ANTHROPIC_API_KEY` via the
  environment or a **`.env`** file in your working dir (auto-loaded at startup; gitignored; exported
  vars win). `.env` is a **host-side** store — it is read into the CLI process and **never mounted
  into the sandbox**. **Keep `.env` at the working-dir root, not inside a mounted skill/project
  folder**, or its contents would be copied into the agent's filesystem.
- The token is passed into the sandbox **off the process argv** (Docker: `-e KEY` inherit-by-name, not
  on `argv`; microVM: a stdin prologue before the agent binary starts), so it is not visible via
  `ps`/`/proc`. It is **never written to disk in a runtime path** and **scrubbed by value** from every
  persisted run log (events/run/trace/result). Still, treat scenario runs like any CI job that holds a key.
- **Scenario files are trusted input.** A scenario's `allow_if` predicate is evaluated as host
  JavaScript (via `new Function`); only run scenarios you trust, the same as any test you'd execute.
- The egress allowlist limits where the agent can send data, but at the `container` tier it is enforced by a proxy + an `internal` Docker network, not a kernel-level netfilter you should rely on against hostile code.

## Supported versions

Pre-1.0: only the latest `main` is supported. Pin a commit for reproducibility.
