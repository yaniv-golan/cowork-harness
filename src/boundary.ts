import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo, homedir } from "node:os";
import { join } from "node:path";
import type { PlatformBaseline } from "./types.js";
import { startEgressSidecar } from "./egress/sidecar.js";

/**
 * Boundary self-test — proves the runtime reproduces Cowork's LIMITATIONS, not
 * just its behavior. Spins up the same per-run sidecar the scenarios use, then runs
 * probes (independent of any agent) and asserts each constraint holds. A skill that
 * passes a scenario here is constrained the same way it would be in real Cowork, so
 * harness-green => Cowork-green on boundary.
 *
 * Mirrors the constraints from app.asar analysis: sealed filesystem (only mounts
 * visible), default-deny egress (gVisor allowlist), cross-boundary via MCP only.
 *
 * VERIFIED: all four constraints enforced on Docker (linux/arm64).
 */
export interface BoundaryResult {
  check: string;
  expectation: string;
  pass: boolean;
  detail: string;
}

/** Session egress additions the boundary self-test should fold into the sidecar allowlist. */
export interface BoundarySessionEgress {
  extraAllow?: string[];
  unrestricted?: boolean;
}

/**
 * The allowlist the boundary sidecar seeds — baseline invariants PLUS the session's egress additions
 * (so the self-test exercises the same boundary a `--session`/scenario run would). `unrestricted` widens
 * to `*`, mirroring buildLaunchPlan's egress resolution. Pure → unit-testable without Docker.
 */
export function boundaryAllowList(baseline: PlatformBaseline, session?: BoundarySessionEgress): string[] {
  if (session?.unrestricted) return ["*"];
  return [...baseline.network.allowDomains, ...(session?.extraAllow ?? [])];
}

export function runBoundaryChecks(baseline: PlatformBaseline, session?: BoundarySessionEgress): BoundaryResult[] {
  const runtime = process.env.COWORK_CONTAINER_RUNTIME ?? "docker";
  const image = process.env.COWORK_AGENT_IMAGE ?? "cowork-agent-base:2";
  const results: BoundaryResult[] = [];

  // Stand up the real per-run boundary (internal network + allowlist proxy), exactly
  // what a container-fidelity scenario uses. Tear it down at the end.
  const runId = `bchk${process.hrtime.bigint().toString(36)}`;
  const tmpDir = mkdtempSync(join(tmpdir(), "cowork-bchk-"));
  const sidecar = startEgressSidecar(boundaryAllowList(baseline, session), tmpDir, runId);
  const network = sidecar.network;
  const proxy = sidecar.proxyUrl;

  // Probes can throw (spawnSync setup errors, etc.); tear the sidecar down in `finally` so an unexpected
  // throw never leaks the proxy container + both Docker networks.
  try {
    const probe = (shell: string, withProxy = false) =>
      spawnSync(
        runtime,
        [
          "run",
          "--rm",
          "--platform",
          "linux/arm64",
          "--network",
          network,
          ...(withProxy ? ["-e", `HTTPS_PROXY=${proxy}`, "-e", `HTTP_PROXY=${proxy}`] : []),
          "--entrypoint",
          "sh",
          image,
          "-c",
          shell,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );

    // 1. Host filesystem is NOT visible (no /Users, no host home bind).
    // TWO independent probes so a leak on EITHER path fails the check — a combined-string
    // probe can false-pass when one path leaks (real listing) but the other path's denial
    // substring satisfies isHostFsSealed's `denied` regex on the joined output.
    {
      const combine = (r: ReturnType<typeof probe>) => (r.stdout ?? "") + (r.stderr ?? "");
      const outUsers = combine(probe("ls /Users 2>&1 || true"));
      const outHost = combine(probe("ls /host 2>&1 || true"));
      const blocked = isHostFsSealed(outUsers) && isHostFsSealed(outHost);
      const detail = (outUsers + "\n" + outHost).trim().slice(0, 200);
      results.push({
        check: "host-fs-sealed",
        expectation: "host paths (/Users, /host) invisible",
        pass: blocked,
        detail,
      });
    }

    // 2. Direct (non-proxied) egress is impossible — no route off the internal net.
    {
      const r = probe(`curl -sS -m 5 -o /dev/null http://example.com && echo REACHED || echo BLOCKED`);
      const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
      results.push({
        check: "direct-egress-denied",
        expectation: "no route to internet without proxy",
        pass: /BLOCKED/.test(out) && !/REACHED/.test(out),
        detail: out,
      });
    }

    // 3. Non-allowlisted egress via the proxy is refused (403).
    {
      const r = probe(`curl -sS -m 5 -o /dev/null https://example.com && echo REACHED || echo BLOCKED`, true);
      const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
      results.push({
        check: "allowlist-enforced",
        expectation: "off-list host refused by proxy",
        pass: /BLOCKED|403/.test(out) && !/REACHED/.test(out),
        detail: out.slice(0, 200),
      });
    }

    // 4. Allowlisted egress via the proxy works (so the agent can reach inference).
    {
      const r = probe(`curl -sS -m 8 -o /dev/null https://api.anthropic.com && echo OK || echo FAIL`, true);
      const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
      results.push({
        check: "allowlist-permits",
        expectation: "allowlisted host reachable via proxy",
        pass: /OK/.test(out),
        detail: out.slice(0, 200),
      });
    }

    return results;
  } finally {
    sidecar.teardown();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort: bind-mounted log may be root-owned on Linux */
    }
  }
}

/** Escape regex metacharacters in a literal so it can be embedded in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * #35: host-fs-sealed pass criterion, made environment-agnostic. The old guard hard-coded the repo
 * owner's username (`yaniv`) in the negative-match, so a real host-path leak on another developer's
 * machine (their username) would not be caught. Build the negative guard from the ACTUAL
 * environment — `os.userInfo().username`, `os.homedir()`, plus the literal host roots `/Users/` and
 * `/opt/cowork/` — escaping regex metacharacters in the dynamic parts.
 *
 * Sealed (pass) ⇔ the probe output looks like a denial ("No such file" etc.) AND contains NONE of
 * the host markers (a leaked username/homedir/host root would mean the host fs is visible).
 */
export function isHostFsSealed(probeOutput: string, env?: { username: string; homedir: string }): boolean {
  const username = env?.username ?? userInfo().username;
  const home = env?.homedir ?? homedir();
  const markers = [escapeRegex(username), escapeRegex(home), "/Users/", "/opt/cowork/"].filter(Boolean);
  const hostMarker = new RegExp(markers.join("|"));
  const denied = /No such file|cannot access|not found/i.test(probeOutput);
  return denied && !hostMarker.test(probeOutput);
}

export function formatBoundary(results: BoundaryResult[]): string {
  const lines = results.map(
    (r) => `${r.pass ? "PASS" : "FAIL"}  ${r.check.padEnd(22)} — ${r.expectation}${r.pass ? "" : `\n        got: ${r.detail}`}`,
  );
  const allPass = results.every((r) => r.pass);
  return `Boundary parity: ${allPass ? "ALL CONSTRAINTS ENFORCED" : "GAPS FOUND"}\n` + lines.join("\n");
}
