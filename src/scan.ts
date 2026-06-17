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

export const DEFAULT_SCAN_PATTERNS: { re: RegExp; cls: string }[] = [
  { re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, cls: "email" },
  { re: /\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|b|bn|million|billion)?/gi, cls: "currency" },
  { re: /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:com|io|net|org|co|app|ai|dev|xyz)\b/gi, cls: "domain" },
];

/** The high-precision subset (email only). `email` is scanned UNIVERSALLY — even on the agent
 *  capability-manifest messages (the `system/init` event and the `initialize` registry `control_response`),
 *  because the registry's `account` field can carry the developer's own email (a real leak). The noisy
 *  classes (`currency`/`domain`) are the ones suppressed on those two manifest messages, where every hit is
 *  the agent's tool/skill catalog or MCP-server names — environment boilerplate a regex can't tell apart
 *  from customer data. Everywhere else (assistant reasoning, tool I/O, decisions, the deliverable) gets the
 *  full net. */
export const EMAIL_SCAN_PATTERNS = DEFAULT_SCAN_PATTERNS.filter((p) => p.cls === "email");

function allowed(sample: string, allow: RegExp[]): boolean {
  // Test against a non-global clone so a caller's /g regex can't carry lastIndex across calls.
  return allow.some((a) => new RegExp(a.source, a.flags.replace("g", "")).test(sample));
}

/** Scan one string for PII matches, suppressing anything the allowlist covers. */
export function scanText(text: string, where: string, allow: RegExp[], patterns = DEFAULT_SCAN_PATTERNS): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const { re, cls } of patterns) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) {
      const sample = m[0];
      if (!allowed(sample, allow)) out.push({ where, cls, sample });
    }
  }
  return out;
}
