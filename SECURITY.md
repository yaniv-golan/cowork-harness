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

### Input-boundary hardening

The harness treats scenario/session YAML, cassettes, and marketplace metadata as **semi-trusted inputs** —
authored by you or your CI, but worth validating so a typo or a copied fixture can't quietly read or write
outside the intended tree. This is defense-in-depth against footguns and accidental host exposure, **not** a
claim that the harness contains a deliberately malicious skill (see the tier guidance above for that). The
following are enforced:

- **Baseline names can't traverse out of `baselines/`** — a named baseline with a path separator / `../` is
  rejected; an absolute path remains the explicit, deliberate out-of-tree escape hatch.
- **Marketplace plugin sources and staged mount roots are containment-checked by real path** (symlinks are
  resolved before the check), so an in-tree symlink that points outside the tree is rejected rather than
  silently followed.
- **Collected artifacts skip hardlinks** (`nlink > 1`) so a hardlink to an out-of-root host file can't inline
  its contents into a committed cassette.
- **The host-loop `web_fetch` SSRF backstop pins the vetted address through connect** (closing a DNS-rebind
  time-of-check/time-of-use gap) and re-vets each redirect hop. As before, this is a backstop for test
  fixtures, not the egress boundary itself — egress is enforced by the per-run proxy / guest firewall.
- **Container infrastructure failures are reported to the model as a generic harness error** (the raw daemon
  text is logged for the operator, not surfaced), so Docker/host details don't leak into model-visible output.

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
