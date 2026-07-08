/**
 * Privacy SCANNER — the always-on CI safety net, distinct from the opt-in redactor. Where the
 * redactor mutates bytes (and is therefore conservative), the scanner only FLAGS, so it runs high-recall and
 * fails the build. A finding means "the redactor's policy has a gap (or wasn't configured)".
 *
 * Default classes (chosen for a low false-positive rate): email, currency, bare domain, local
 * absolute path (the recording machine's own filesystem — /Users, /home, /root — not the in-VM
 * /sessions mount tree), machine-inventory (the sentinel boilerplate a tool emits when it has
 * LIVE-ENUMERATED local environment state — installed apps, running processes — into its
 * schema/description/output; matches the introducer phrase only, never app names or list shapes).
 * Multi-word proper names are deliberately NOT a default — too noisy (NVCA, Cap Table, Cooley GO)
 * to gate on; add them via config when a corpus warrants it. The allowlist suppresses
 * known-synthetic / public reference names.
 */
export interface ScanFinding {
  where: string; // a human locator, e.g. "events[3]" or "artifact outputs/x.json"
  cls: string; // matched class: email | currency | domain | path | machine-inventory | <custom>
  sample: string; // the matched text (already redaction-survived, so safe to surface)
}

/** An allowlist entry. `cls` undefined = applies to every class (a bare `--allow`); `cls` set = scoped to one
 *  finding class (`--allow-domain` → "domain"). Scoping plus whole-token anchoring stops a domain allow from
 *  silently clearing an email finding whose domain it happens to match. */
export interface AllowPattern {
  cls?: string;
  re: RegExp;
}

/** Allow entries may be authored as a bare RegExp (all-class, the ergonomic default) or a scoped {cls,re}. */
export type AllowInput = RegExp | AllowPattern;

function normAllow(a: AllowInput): AllowPattern {
  return a instanceof RegExp ? { re: a } : a;
}

export const DEFAULT_SCAN_PATTERNS: { re: RegExp; cls: string }[] = [
  { re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, cls: "email" },
  { re: /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|b|bn|million|billion)?/gi, cls: "currency" },
  {
    re: /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:com|io|net|org|co|app|ai|dev|xyz|vc|fund|capital|tech|cloud|health|finance|us|uk|de|fr|ca|au|me|tv|info|biz|edu|gov|mil|ch|nl|se|no|it|jp|br|nz|in|sg|kr|mx|es|pt|pl|be|at|dk|fi|ie|ru|cn|tw|hu|cz|ro|il|za|ar|cl|pe|tr)\b/gi,
    cls: "domain",
  },
  {
    // A real local absolute path — the recording machine's own filesystem, not the in-VM /sessions/
    // mount tree. Boundary-anchored via a zero-width NEGATIVE LOOKBEHIND (not a capturing group — a
    // capturing group here would leak the boundary char itself into m[0]/ScanFinding.sample, e.g. a
    // leading space or quote, which then breaks --allow-path since allowed() anchors the allow-regex
    // against the WHOLE sample) so a substring like "whatever/home/x" doesn't false-match, only a
    // genuine path-like "/home/...". Modeled on the boundary approach in src/run/execute.ts's
    // hostPathLeaked — deliberately NOT sharing code with it: that function is an encoding-aware
    // boolean check over an agent's free-form output at run time, this is a plain match-extraction
    // over structured JSON at scan time (a deliberate design decision: structured extraction beats
    // a boolean over free-form text here). Unix-only by scope — a Windows path (C:\Users\...) does not match; this repo
    // records via Docker/Lima on macOS/Linux.
    // macOS-host-only prefixes (/private/var, /var/folders, /Volumes) are included alongside the
    // universal /Users//home//root so a leaked temp-dir or external-volume host path is caught too —
    // matching the (deliberately separate, encoding-aware) run-level `hostPathLeaked` detector's prefix
    // set. `/opt/cowork/` is intentionally NOT here: the microvm tier legitimately mounts the agent at
    // /opt/cowork/agent (src/runtime/lima.ts), so its appearance in a recording is expected, not a leak.
    re: /(?<![^\s"'(=:])(\/Users\/|\/home\/|\/root\/|\/private\/var\/|\/var\/folders\/|\/Volumes\/)[^\s"')]+/gi,
    cls: "path",
  },
  {
    // Machine-inventory sentinel: the introducer boilerplate a tool emits when it has LIVE-ENUMERATED
    // local environment state (installed apps, running processes) into its schema/description/output —
    // e.g. computer-use's request_access description: "Available applications on this machine:
    // AppOne, AppTwo, AppThree, …".
    // NOTE: use a synthetic app list in this comment and in any test fixture — never a real captured one
    // (the class this comment documents exists specifically to stop that kind of leak from being committed).
    // Matches the PHRASE ONLY (bounded at the optional colon), not the trailing list — the sample stays
    // machine-independent and short, so a reviewed --allow-machine-inventory regex can whole-token match
    // it (allowed() anchors ^(?:…)$ against the WHOLE sample; a machine-varying list tail would make
    // every allow brittle — same lesson as the path class's lookbehind fix). The class deliberately does
    // NOT pattern-match app names or list shapes: enumerated Title-Case lists are ubiquitous legitimate
    // catalog content here (the same noise that got currency/domain excluded from manifest lines), while
    // this boilerplate is never legitimate synthetic-fixture content. Multiple entries may share this cls
    // (scanText loops entries, not classes) — extend by adding sibling regexes, not by widening this one.
    re: /\b(?:(?:available|installed|running)\s+(?:applications?|apps|processes)|(?:applications?|apps|processes)\s+(?:currently\s+)?(?:available|installed|running))\s+on\s+(?:this|the|your)\s+(?:machine|computer|system|device|mac|host)\b\s*:?/gi,
    cls: "machine-inventory",
  },
];

/** The high-precision subset scanned UNIVERSALLY — even on the agent capability-manifest messages
 *  (the `system/init` event and the `initialize` registry `control_response`). `email` because the
 *  registry's `account` field can carry the developer's own email (a real leak); `path` because those
 *  same messages' structural fields (`cwd`, `plugins[].path`, `memory_paths`) are exactly where a real
 *  local filesystem path — leaking a username, plugin-cache layout, or private marketplace name — lives;
 *  `machine-inventory` because a future capability-manifest variant that inlines MCP tool
 *  descriptions (plausible: `system/init` already lists `mcp_servers`) could carry a live-enumerated
 *  app/process inventory in a structural field, and the sentinel is never legitimate catalog boilerplate
 *  the way a skill/tool description's prose can be. The noisy classes (`currency`/`domain`) are the ones
 *  suppressed on those two manifest messages, where every hit is the agent's tool/skill catalog or
 *  MCP-server names — environment boilerplate a regex can't tell apart from customer data. None of
 *  `email`/`path`/`machine-inventory` share that ambiguity: a real address, a real absolute path, or the
 *  live-inventory sentinel are never legitimate catalog boilerplate. Everywhere else (assistant
 *  reasoning, tool I/O, decisions, the deliverable) gets the full net. */
export const MANIFEST_SCAN_PATTERNS = DEFAULT_SCAN_PATTERNS.filter(
  (p) => p.cls === "email" || p.cls === "path" || p.cls === "machine-inventory",
);

function allowed(sample: string, cls: string, allow: AllowPattern[]): boolean {
  // An allow suppresses a finding only when (a) it is unscoped OR scoped to this finding's class, AND (b) it
  // matches the WHOLE finding token. Anchoring with ^(?:…)$ is the fix: substring matching let a domain
  // allow (e.g. `example\.com`) silently clear an EMAIL finding (`alice@example.com`) whose domain matched —
  // a real founder@startup.com could then pass a gate that "has an email class". Test against a non-global
  // clone so a caller's /g regex can't carry lastIndex across calls.
  return allow.some((a) => {
    if (a.cls !== undefined && a.cls !== cls) return false;
    return new RegExp(`^(?:${a.re.source})$`, a.re.flags.replace("g", "")).test(sample);
  });
}

/** Scan one string for PII matches, suppressing anything the (class-scoped, whole-token) allowlist covers. */
export function scanText(text: string, where: string, allow: AllowInput[], patterns = DEFAULT_SCAN_PATTERNS): ScanFinding[] {
  const out: ScanFinding[] = [];
  const norm = allow.map(normAllow);
  for (const { re, cls } of patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) {
      const sample = m[0];
      if (!allowed(sample, cls, norm)) out.push({ where, cls, sample });
    }
  }
  return out;
}
