import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeWorkspaceHandler,
  isExecInfraError,
  type RawFetch,
  type Resolver,
  type EgressEntry,
  type WebFetchProvenance,
} from "../src/hostloop/workspace-handler.js";

// Token-free, network-free coverage for #39 (DNS-rebind TOCTOU / address pinning) and
// #40 (Docker infra-error classification). Both drive the real handler; #40 uses a fake
// `runner` binary so the `docker exec` infra-failure shape is exercised without Docker.

// ---------------------------------------------------------------------------------------------
// #39 — the SSRF backstop resolves ONCE and PINS the fetch to that vetted address, so a host that
// answers public for the check can't be re-resolved to a private address by the fetch (DNS rebind).
// ---------------------------------------------------------------------------------------------
describe("#39 — web_fetch pins the fetch to the SSRF-vetted address (no second resolution)", () => {
  // Path B (provenance off) driver: inject the per-hop fetch + resolver (spawn-free).
  const callB = async (url: string, allow: string[], rawFetch: RawFetch, resolve: Resolver) => {
    const egress: EgressEntry[] = [];
    const h = makeWorkspaceHandler("c", "/mnt", "docker", allow, (e) => egress.push(e), undefined, undefined, rawFetch, resolve);
    const out = (await h("workspace", { method: "tools/call", params: { name: "web_fetch", arguments: { url } } })) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return { text: out.result.content[0].text, isError: out.result.isError, egress };
  };

  it("hands the vetted resolved address to rawFetch (the fetch dials the checked IP, not a re-resolution)", async () => {
    let pinnedSeen: string[] | undefined;
    const rawFetch: RawFetch = async (_url, pinned) => {
      pinnedSeen = pinned;
      return { status: 200, text: async () => "BODY" };
    };
    // Resolver returns a single public address; the handler must pass exactly that address through.
    const resolve: Resolver = async () => [{ address: "203.0.113.7" }];
    const r = await callB("http://example.com/x", ["example.com"], rawFetch, resolve);
    expect(r.text).toBe("BODY");
    expect(pinnedSeen).toEqual(["203.0.113.7"]); // the vetted IP was pinned, not the bare hostname
  });

  it("a host that resolves public-then-private is blocked: only the VETTED address is ever fetched", async () => {
    // The classic rebind: first resolution (the gate) answers public; a naive fetch would re-resolve and
    // get the private address. Here resolve() is consulted ONCE; whatever it returns is what gets pinned.
    // We assert the private answer is denied before any fetch, and the public answer pins the public IP.
    const fetched: string[][] = [];
    const rawFetch: RawFetch = async (_url, pinned) => {
      fetched.push(pinned ?? []);
      return { status: 200, text: async () => "BODY" };
    };
    // private resolution → denied, fetch never reached.
    const toPrivate: Resolver = async () => [{ address: "127.0.0.1" }];
    const denied = await callB("http://rebind.example/x", ["rebind.example"], rawFetch, toPrivate);
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/resolves to a local or private address \(127\.0\.0\.1\)/);
    expect(fetched.length).toBe(0); // blocked at the gate — no fetch with any address

    // public resolution → the public IP is pinned through to the fetch.
    const toPublic: Resolver = async () => [{ address: "198.51.100.9" }];
    const ok = await callB("http://rebind.example/x", ["rebind.example"], rawFetch, toPublic);
    expect(ok.text).toBe("BODY");
    expect(fetched).toEqual([["198.51.100.9"]]);
  });

  it("re-checks AND re-pins on a redirect hop (the new host's vetted address is pinned)", async () => {
    const pinnedPerHop: (string[] | undefined)[] = [];
    let n = 0;
    const rawFetch: RawFetch = async (_url, pinned) => {
      pinnedPerHop.push(pinned);
      return n++ === 0
        ? { status: 302, location: "http://second.example/y", text: async () => "" }
        : { status: 200, text: async () => "FINAL" };
    };
    const resolve: Resolver = async (host) => [{ address: host === "first.example" ? "203.0.113.1" : "203.0.113.2" }];
    const r = await callB("http://first.example/x", ["first.example", "second.example"], rawFetch, resolve);
    expect(r.text).toMatch(/FINAL/);
    expect(pinnedPerHop).toEqual([["203.0.113.1"], ["203.0.113.2"]]); // each hop pinned to its own vetted IP
  });

  it("a LITERAL public IP host pins nothing (no re-resolution needed) and still fetches", async () => {
    let pinnedSeen: string[] | undefined = ["sentinel"];
    const rawFetch: RawFetch = async (_url, pinned) => {
      pinnedSeen = pinned;
      return { status: 200, text: async () => "BODY" };
    };
    const tripwire: Resolver = async () => {
      throw new Error("resolver must not be consulted for a literal IP");
    };
    const r = await callB("http://8.8.8.8/x", ["*"], rawFetch, tripwire);
    expect(r.text).toBe("BODY");
    expect(pinnedSeen).toEqual([]); // literal IP → empty pin list → default fetch path (unchanged)
  });
});

// ---------------------------------------------------------------------------------------------
// #40 — a `docker exec` infra failure that exits NON-ZERO WITH stderr must be classified as infra:
// recorded to the run log, and a GENERIC error returned to the model (no verbatim daemon text).
// ---------------------------------------------------------------------------------------------
describe("#40 — isExecInfraError classifier", () => {
  it("catches timeouts and kills regardless of output (preserved behavior)", () => {
    expect(isExecInfraError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isExecInfraError({ killed: true, stderr: "partial" })).toBe(true);
  });
  it("catches a pure spawn failure (no code, no output)", () => {
    expect(isExecInfraError({})).toBe(true);
  });
  it("catches a Docker daemon failure that exits 125 WITH stderr (the missed case)", () => {
    expect(isExecInfraError({ code: 125, stderr: "Error response from daemon: No such container: c" })).toBe(true);
  });
  it("catches daemon-down / not-running / no-such-container by stderr signature (non-125 codes too)", () => {
    expect(isExecInfraError({ code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." })).toBe(true);
    expect(isExecInfraError({ code: 1, stderr: 'Error response from daemon: Container "c" is not running' })).toBe(true);
    expect(isExecInfraError({ code: 1, stderr: "Error: No such container: c" })).toBe(true);
  });
  it("does NOT classify an ordinary command non-zero exit with stderr as infra", () => {
    expect(isExecInfraError({ code: 1, stderr: "bash: nonexistent: command not found" })).toBe(false);
    expect(isExecInfraError({ code: 2, stdout: "", stderr: "grep: no match" })).toBe(false);
  });
  // Adversarial-review P2: the bare phrases "is not running" / "no such container" must NOT misclassify a
  // legitimate command's own output (e.g. a service status check) as a docker infra failure — they count
  // only on a docker ERROR line, not anywhere in arbitrary stderr.
  it("does NOT misclassify a legit command whose output merely contains the docker phrases", () => {
    expect(isExecInfraError({ code: 3, stderr: "nginx is not running\n" })).toBe(false);
    expect(isExecInfraError({ code: 1, stdout: "checking… no such container in my inventory file", stderr: "" })).toBe(false);
    // still infra when it IS a docker error line:
    expect(isExecInfraError({ code: 1, stderr: "Error: No such container: c" })).toBe(true);
  });
});

describe("#40 — execInContainer surfaces infra failures generically (not verbatim daemon text)", () => {
  // A fake `runner` that mimics `docker exec` against a missing container: exit 125 with the daemon's
  // error on stderr. The handler must NOT relay that text to the model, and must call onInfraError.
  const makeFakeRunner = (script: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "fake-runner-"));
    const f = join(dir, "runner.sh");
    writeFileSync(f, script);
    chmodSync(f, 0o755);
    return f;
  };

  const callBash = async (runner: string) => {
    const infra: string[] = [];
    const h = makeWorkspaceHandler("c", "/mnt", runner, ["*"], undefined, (m) => infra.push(m));
    const out = (await h("workspace", { method: "tools/call", params: { name: "bash", arguments: { command: "echo hi" } } })) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    return { text: out.result.content[0].text, isError: out.result.isError, infra };
  };

  it("a daemon-style exit-125-with-stderr is classified as infra: generic to the model, raw to the log", async () => {
    const runner = makeFakeRunner("#!/bin/sh\n" + 'echo "Error response from daemon: No such container: c" 1>&2\n' + "exit 125\n");
    const r = await callBash(runner);
    expect(r.isError).toBe(true);
    // Model sees only the generic harness error — NOT the docker daemon text and NOT `[exit 125]`.
    expect(r.text).toBe("[infrastructure error: see run log for details]");
    expect(r.text).not.toMatch(/Error response from daemon/);
    expect(r.text).not.toMatch(/\[exit 125\]/);
    // The raw infra detail (incl. the daemon stderr) is recorded for the run log.
    expect(r.infra.length).toBe(1);
    expect(r.infra[0]).toMatch(/Error response from daemon: No such container/);
  });

  it("an ORDINARY command non-zero exit still surfaces its exit code + output to the model", async () => {
    const runner = makeFakeRunner("#!/bin/sh\n" + 'echo "boom" 1>&2\n' + "exit 3\n");
    const r = await callBash(runner);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^\[exit 3\]/); // a genuine command failure is reported verbatim, with its code
    expect(r.text).toMatch(/boom/);
    expect(r.infra.length).toBe(0); // not an infra failure → onInfraError not called
  });
});

// Keep the provenance/SSRF fakes' shape honest: the WebFetchProvenance/RawFetch contracts compile.
const _typecheckGuard: WebFetchProvenance = { isAllowed: () => true, markAllowed: () => {}, promptGateOn: false };
void _typecheckGuard;
