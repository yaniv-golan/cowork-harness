/**
 * Injected-secret collection + scrubbing, shared by the run boundary (post-run file scrub) AND the
 * external decider (LIVE scrub before a request is emitted to stdout/a helper). Keeping this in one
 * place means the external channel can never out-run the file scrub and leak a token (Opus C1).
 */
// #46: minimum length threshold for scrubbing a secret. We guard only against empty strings (length
// < 1) to ensure short but real tokens are still redacted. The known secret-bearing keys
// (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY) always exceed this, but lowering from 8 to 1 ensures
// future short API keys or test tokens are never silently passed through. We still skip empty strings
// to avoid splitting every character with "[REDACTED]".
const MIN_SECRET_LENGTH = 1;

// #31: the known secret-bearing env keys to scrub. Beyond the three auth tokens, `ANTHROPIC_CUSTOM_HEADERS`
// can carry a bearer/proxy credential. Users add more (proxy creds, MCP server tokens) via
// COWORK_HARNESS_SCRUB_KEYS (comma-separated env-var names), or literal values via COWORK_HARNESS_SCRUB_VALUES.
const KNOWN_SECRET_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"];

function csv(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function collectSecrets(): string[] {
  const out: string[] = [];
  const push = (v: string | undefined) => {
    if (v && v.length >= MIN_SECRET_LENGTH) {
      out.push(v);
      out.push(Buffer.from(v).toString("base64"));
      out.push(encodeURIComponent(v));
      out.push(JSON.stringify(v).slice(1, -1));
      out.push("Bearer " + v);
    }
  };
  for (const k of [...KNOWN_SECRET_KEYS, ...csv(process.env.COWORK_HARNESS_SCRUB_KEYS)]) push(process.env[k]);
  for (const literal of csv(process.env.COWORK_HARNESS_SCRUB_VALUES)) push(literal); // scrub these regardless of env
  return out;
}

export function scrub(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) if (s) t = t.split(s).join("[REDACTED]");
  return t;
}

/**
 * Like `scrub`, but additionally detects secrets embedded in whole-field encodings where
 * surrounding bytes shift the alphabet (base64(prefix + TOKEN + suffix), URI-encoded blobs).
 * If a hit is found in the decoded form, the ENTIRE encoded field is replaced — never partial
 * redaction, which would break any SHA-256 hash stored alongside the field.
 * Only attempt decoding on field-shaped values (not arbitrary long text).
 */
export function scrubField(value: string, secrets: string[]): string {
  // Direct scrub first — covers literal, base64(TOKEN), encodeURIComponent(TOKEN), etc.
  const direct = scrub(value, secrets);
  if (direct !== value) return direct;

  // Secondary: whole-field base64 decode. Guard: plausibly base64-shaped (only base64 chars,
  // length ≥ 20 to avoid false positives on short label strings).
  if (value.length >= 20 && /^[A-Za-z0-9+/=]+$/.test(value)) {
    try {
      const decoded = Buffer.from(value, "base64").toString("utf8");
      // Only act if the decoded form is different and contains a secret hit.
      if (decoded !== value && scrub(decoded, secrets) !== decoded) {
        return "[REDACTED:base64]";
      }
    } catch {
      // Not valid base64 — skip.
    }
  }

  // Secondary: whole-field URI encoding.
  if (value.includes("%")) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded !== value && scrub(decoded, secrets) !== decoded) {
        return "[REDACTED:uri]";
      }
    } catch {
      // Not valid URI encoding — skip.
    }
  }

  return direct;
}
