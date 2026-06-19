/**
 * Privacy SCANNER (#1 / A2) — the always-on CI safety net, distinct from the opt-in redactor. Where the
 * redactor mutates bytes (and is therefore conservative), the scanner only FLAGS, so it runs high-recall and
 * fails the build. A finding means "the redactor's policy has a gap (or wasn't configured)".
 *
 * Default classes (chosen for a low false-positive rate): email, currency, bare domain. Multi-word proper
 * names are deliberately NOT a default — too noisy (NVCA, Cap Table, Cooley GO) to gate on; add them via
 * config when a corpus warrants it. The allowlist suppresses known-synthetic / public reference names.
 */
export interface ScanFinding {
  where: string; // a human locator, e.g. "events[3]" or "artifact outputs/x.json"
  cls: string; // matched class: email | currency | domain | <custom>
  sample: string; // the matched text (already redaction-survived, so safe to surface)
}

/** An allowlist entry. `cls` undefined = applies to every class (a bare `--allow`); `cls` set = scoped to one
 *  finding class (`--allow-domain` → "domain"). Scoping plus whole-token anchoring stops a domain allow from
 *  silently clearing an email finding whose domain it happens to match (F-2). */
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
];

/** The high-precision subset (email only). `email` is scanned UNIVERSALLY — even on the agent
 *  capability-manifest messages (the `system/init` event and the `initialize` registry `control_response`),
 *  because the registry's `account` field can carry the developer's own email (a real leak). The noisy
 *  classes (`currency`/`domain`) are the ones suppressed on those two manifest messages, where every hit is
 *  the agent's tool/skill catalog or MCP-server names — environment boilerplate a regex can't tell apart
 *  from customer data. Everywhere else (assistant reasoning, tool I/O, decisions, the deliverable) gets the
 *  full net. */
export const EMAIL_SCAN_PATTERNS = DEFAULT_SCAN_PATTERNS.filter((p) => p.cls === "email");

function allowed(sample: string, cls: string, allow: AllowPattern[]): boolean {
  // An allow suppresses a finding only when (a) it is unscoped OR scoped to this finding's class, AND (b) it
  // matches the WHOLE finding token. Anchoring with ^(?:…)$ is the F-2 fix: substring matching let a domain
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
