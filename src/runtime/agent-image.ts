import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { warn } from "../io.js";

/** Single source of truth for WHICH agent image the harness runs, WHICH container runtime runs it, and
 *  WHICH egress proxy image the per-run sidecar starts.
 *
 *  Both were previously resolved by a duplicated `process.env.X ?? "default"` expression — the image at 7
 *  call sites, the runtime at 10. Duplicating a default is a slow leak: the default value and the override
 *  semantics can drift apart one site at a time, and nothing fails when they do. `test/agent-image.test.ts`
 *  carries a structural guard that these env vars are read nowhere else in `src/`. */

/** The unqualified LOCAL tag the harness runs. Deliberately not a `ghcr.io/...` ref: `README.md`
 *  documents building this tag locally, and resolving a registry ref here would bypass that path. */
export const AGENT_IMAGE_DEFAULT = "cowork-agent-base:2";

/** The egress proxy image the per-run sidecar runs (and doctor probes for).
 *
 *  The tag is part of the CONTRACT, not decoration: the sidecar reuses an image on tag existence alone, so
 *  ANY change to Dockerfile.proxy or to the dist/egress code it bakes in reaches nobody who already built
 *  the old tag — a stale image keeps serving, and doctor keeps calling it healthy. Bump this whenever a
 *  change must actually reach existing installs (a decision-log format change was the original such case;
 *  the base-image move to node:22-slim is another). :3 = the node:22-slim base; :4 = the explicit
 *  `host:'0.0.0.0'` bind (the proxy now defaults to loopback, so the sidecar — which the agent container
 *  reaches ACROSS the docker network — must ask for a non-loopback bind by name); :5 = CONNECT answers 502
 *  + logs a structured `upstream_error` when the upstream fails before the tunnel is established (it used
 *  to destroy the socket silently, leaving an intermittent with no artifact — see the error handler in
 *  proxy.ts). `test/egress-proxy-image-tag.test.ts` pins this tag to Dockerfile.proxy's digest. */
export const PROXY_IMAGE_DEFAULT = "cowork-egress-proxy:5";

/** The container runtime used for the agent image and the egress sidecar. */
export const CONTAINER_RUNTIME_DEFAULT = "docker";

/** An override is honoured only when it carries a non-blank value. `??` alone passes `""` through, so a
 *  bare `COWORK_AGENT_IMAGE=` in a `.env` or a shell export yielded an empty ref and every container
 *  invocation failed with an opaque runtime error rather than falling back to the default. */
function override(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

export function resolveAgentImage(env: NodeJS.ProcessEnv = process.env): string {
  return override(env.COWORK_AGENT_IMAGE, AGENT_IMAGE_DEFAULT);
}

/** Resolved at CALL time, never captured at module load: the CLI statically imports the sidecar and only
 *  then loads `.env` into process.env, so a load-time read would miss a `.env` value that doctor sees. */
export function resolveProxyImage(env: NodeJS.ProcessEnv = process.env): string {
  return override(env.COWORK_PROXY_IMAGE, PROXY_IMAGE_DEFAULT);
}

export function resolveContainerRuntime(env: NodeJS.ProcessEnv = process.env): string {
  return override(env.COWORK_HARNESS_CONTAINER_RUNTIME, CONTAINER_RUNTIME_DEFAULT);
}

interface AgentImageManifest {
  revision: number;
  variants: Record<string, { digest: string | null }>;
}

const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docker", "agent-image.json");

/** The registry manifest digest this harness build expects `image` to resolve to, or null when the image
 *  is not one we publish. Read from DISK, never the network — the check must work offline, which the
 *  previous `docker buildx imagetools inspect` round-trip could not.
 *
 *  Keyed by the FULL local ref (`cowork-agent-base:2`), never by the name alone: keying by name would pin
 *  every tag of a published name, so `cowork-agent-base:probe` or a future `:3` would be compared against
 *  the `:2` digest and reported stale forever. Mirrors `ghcrRefFor`'s full-tag map in doctor.ts, and a
 *  test cross-checks the two key sets.
 *
 *  A MALFORMED entry warns loudly rather than returning null: silently degrading a corrupt pin to
 *  "unpinned" makes operator error indistinguishable from "no pin configured", which is the fail-open
 *  class this pin exists to close. `repo@sha256:…` is accepted and normalized, because that is exactly
 *  what `docker inspect .RepoDigests` prints and therefore what a hand-written entry is likely to be. */
export function pinnedDigestFor(image: string): string | null {
  let manifest: AgentImageManifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as AgentImageManifest;
  } catch {
    return null; // `docker/` ships in package.json files[], so this is a broken install, not a normal path
  }
  const raw = manifest.variants?.[image]?.digest;
  if (raw === null || raw === undefined) return null;
  const normalized = typeof raw === "string" && raw.includes("@") ? raw.slice(raw.indexOf("@") + 1) : raw;
  if (typeof normalized === "string" && /^sha256:[0-9a-f]{64}$/.test(normalized)) return normalized;
  warn(
    `::warning:: [image] docker/agent-image.json has a malformed digest for ${image} (${String(raw)}) — ` +
      `the agent-image pin is NOT being checked this run.\n`,
  );
  return null;
}
