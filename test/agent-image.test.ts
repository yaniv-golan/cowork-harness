import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_IMAGE_DEFAULT,
  PROXY_IMAGE_DEFAULT,
  pinnedDigestFor,
  resolveAgentImage,
  resolveContainerRuntime,
  resolveProxyImage,
} from "../src/runtime/agent-image.js";

// The agent image ref and the container runtime were each resolved by a duplicated
// `process.env.X ?? "default"` expression at 7 and 10 call sites respectively. Duplication of a DEFAULT
// is a slow leak: the default and the override semantics can drift apart one site at a time, and nothing
// fails when they do. One definition ⇒ every spawn path, probe, and doctor check agrees by construction.

describe("resolveAgentImage", () => {
  it("defaults to the unqualified local tag", () => {
    // Deliberately NOT a ghcr.io ref: README documents building this tag locally, and resolving a
    // registry ref here would bypass that supported path.
    expect(resolveAgentImage({})).toBe("cowork-agent-base:2");
    expect(AGENT_IMAGE_DEFAULT).toBe("cowork-agent-base:2");
  });

  it("honours COWORK_AGENT_IMAGE", () => {
    expect(resolveAgentImage({ COWORK_AGENT_IMAGE: "cowork-agent-full:2" })).toBe("cowork-agent-full:2");
  });

  it("treats an empty or whitespace override as unset", () => {
    // `??` passes "" straight through, so `COWORK_AGENT_IMAGE=` in a .env or a shell export produced an
    // empty image ref and every container invocation failed with an opaque runtime error instead of
    // falling back to the default.
    expect(resolveAgentImage({ COWORK_AGENT_IMAGE: "" })).toBe(AGENT_IMAGE_DEFAULT);
    expect(resolveAgentImage({ COWORK_AGENT_IMAGE: "   " })).toBe(AGENT_IMAGE_DEFAULT);
  });
});

describe("resolveProxyImage", () => {
  it("defaults to the exported proxy tag", () => {
    expect(resolveProxyImage({})).toBe(PROXY_IMAGE_DEFAULT);
    expect(PROXY_IMAGE_DEFAULT).toMatch(/^cowork-egress-proxy:\d+$/);
  });

  it("honours COWORK_PROXY_IMAGE", () => {
    expect(resolveProxyImage({ COWORK_PROXY_IMAGE: "my-proxy:7" })).toBe("my-proxy:7");
  });

  it("treats an empty or whitespace override as unset", () => {
    // Same rule as the agent image: a bare `COWORK_PROXY_IMAGE=` must not reach `docker image inspect ""`.
    expect(resolveProxyImage({ COWORK_PROXY_IMAGE: "" })).toBe(PROXY_IMAGE_DEFAULT);
    expect(resolveProxyImage({ COWORK_PROXY_IMAGE: "  " })).toBe(PROXY_IMAGE_DEFAULT);
  });

  it("reads the environment at call time, not at import time", () => {
    // `.env` is loaded into process.env AFTER the CLI's static imports have run, so a value captured when
    // a module loads would miss it.
    const prev = process.env.COWORK_PROXY_IMAGE;
    try {
      process.env.COWORK_PROXY_IMAGE = "late-proxy:1";
      expect(resolveProxyImage()).toBe("late-proxy:1");
    } finally {
      if (prev === undefined) delete process.env.COWORK_PROXY_IMAGE;
      else process.env.COWORK_PROXY_IMAGE = prev;
    }
  });
});

describe("resolveContainerRuntime", () => {
  it("defaults to docker", () => {
    expect(resolveContainerRuntime({})).toBe("docker");
  });

  it("honours COWORK_HARNESS_CONTAINER_RUNTIME", () => {
    expect(resolveContainerRuntime({ COWORK_HARNESS_CONTAINER_RUNTIME: "podman" })).toBe("podman");
  });

  it("treats an empty or whitespace override as unset", () => {
    expect(resolveContainerRuntime({ COWORK_HARNESS_CONTAINER_RUNTIME: "" })).toBe("docker");
    expect(resolveContainerRuntime({ COWORK_HARNESS_CONTAINER_RUNTIME: "  " })).toBe("docker");
  });
});

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...srcFiles(abs));
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

describe("single-source guard", () => {
  const RESOLVER = join("src", "runtime", "agent-image.ts");

  it("reads COWORK_AGENT_IMAGE, COWORK_HARNESS_CONTAINER_RUNTIME and COWORK_PROXY_IMAGE only in the resolver", () => {
    // Structural, because there is no behavioural test that would catch a re-introduced literal: a copy
    // with the old `??` semantics passes every existing test while silently reviving the empty-string bug.
    const offenders = srcFiles("src")
      .filter((f) => f !== RESOLVER)
      .filter((f) => /process\.env\.COWORK_(AGENT_IMAGE|CONTAINER_RUNTIME|PROXY_IMAGE)\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("pinnedDigestFor", () => {
  it("returns a real digest for each published variant — an unpinned release is a fail-open", () => {
    // The whole point of the pin: a null pin makes doctor report `skip`, which is indistinguishable from
    // "checked and fine". This assertion is what stops a release shipping a check that does nothing.
    expect(pinnedDigestFor("cowork-agent-base:2")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pinnedDigestFor("cowork-agent-full:2")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("pins the full-parity variant independently of the base", () => {
    // A shared pin would give every COWORK_AGENT_IMAGE=cowork-agent-full:2 user a permanent false `stale`.
    expect(pinnedDigestFor("cowork-agent-full:2")).not.toBe(pinnedDigestFor("cowork-agent-base:2"));
  });

  it("keys by the FULL local ref, so a different tag of a published name is NOT pinned", () => {
    // `image.split(":")[0]` would match every tag of the name — including `:probe` (which the recipe
    // test's own build instructions produce) and any future `:3`, each getting a bogus `stale`.
    expect(pinnedDigestFor("cowork-agent-base:probe")).toBeNull();
    expect(pinnedDigestFor("cowork-agent-base:3")).toBeNull();
    expect(pinnedDigestFor("cowork-agent-base")).toBeNull();
  });

  it("returns null for a custom image rather than pretending it is pinned", () => {
    expect(pinnedDigestFor("my-registry.corp/custom:latest")).toBeNull();
  });
});
