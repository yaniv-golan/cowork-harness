import { applyParsedCommandGlobals, withCommandGlobals } from "./command-globals.js";
import { FIDELITY_TIERS } from "../types.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../cli-args.js";
import {
  resolveAgentBinary,
  resolveHostAgentBinary,
  classifyNativeStagingDrift,
  AgentBinaryError,
  type NativeStagingDrift,
  loadBaseline,
  sha256File,
  isPatchBump,
} from "../baseline.js";
import { decideLoopFromBaseline } from "../loop-decision.js";
import { limaPath, vmStatus, instanceName, vmProvisioned } from "../runtime/lima.js";
import { fail, isJsonOutput, jsonPayloadEnvelope } from "./envelope.js";
import { writeAllSync } from "../io.js";
import { pinnedDigestFor, resolveAgentImage, resolveContainerRuntime, resolveProxyImage } from "../runtime/agent-image.js";

// Synchronous fd writes (match cli.ts): machine→stdout, human→stderr. A `process.stdout.write` +
// `process.exit()` pair truncates on a PIPE (async tail dropped at exit past the ~64KB buffer);
// writeAllSync retries EAGAIN and loops on short writes so the whole payload lands (see src/io.ts).
const out = (s: string) => writeAllSync(1, s + "\n");
const log = (s: string) => writeAllSync(2, s + "\n");

type Tier = "protocol" | "container" | "microvm" | "hostloop" | "cowork";
const LIVE_TIERS: Tier[] = ["container", "microvm", "hostloop", "cowork"];
const isLive = (t: Tier) => LIVE_TIERS.includes(t);

type Status = "ok" | "fail" | "warn" | "skip";

/** Result of the advisory image-freshness probe (container/hostloop/cowork only). Compared against the
 *  digest this harness build PINS (`docker/agent-image.json`), read from disk — so unlike the previous
 *  registry round-trip, the check works OFFLINE and its verdict has a direction:
 *  - `current`  — the local pulled image is the digest this build pins.
 *  - `stale`    — a PULLED image that is not the pinned digest; `pinnedRef` is digest-addressed so the
 *                 remedy converges (pulling floating `:2` would not, once a newer revision exists).
 *  - `local`    — built locally (empty RepoDigests, so nothing to compare); not a warning.
 *  - `unpinned` — this build publishes no digest for that image; never reported as `current`.
 *  - `unknown`  — custom `COWORK_AGENT_IMAGE`, or the local inspect failed (daemon down). A stopped
 *                 daemon must land here, NOT in `local` — "built locally" would be a confident lie. */
export type ImageFreshness =
  | { state: "current"; detail: string }
  | { state: "stale"; detail: string; ghcrRef: string; pinnedRef: string }
  | { state: "local"; detail: string }
  | { state: "unpinned"; detail: string }
  | { state: "unknown"; detail: string };

/** The whole freshness DECISION, with no spawning, so it is testable. The probe seam the doctor tests use
 *  injects `imageFreshness` wholesale, so a comparison living inside `realProbe` would have zero coverage:
 *  probe-level tests can only ever exercise the `state -> status` mapping.
 *
 *  `ghcrRef` is nullable because its only producer, `ghcrRefFor`, returns `string | null`.
 *  `localDigest` is null for a locally-built image (empty RepoDigests); `pin` is null when this build
 *  publishes no digest for that image. I/O failures stay in the caller and surface as `unknown` — a user
 *  whose Docker daemon is down must never be told their image was "built locally". */
/** Pick the registry digest for THIS image out of `docker image inspect`'s RepoDigests.
 *
 *  Docker records a RepoDigest per repository the image is known by, and the set is not predictable: a
 *  pulled-then-retagged image may carry `ghcr.io/owner/name@sha256:…`, or only the bare `name@sha256:…`,
 *  or both. Matching the ghcr-qualified form alone silently missed the bare form — `cowork-agent-full:2`
 *  carries only the short name on a real machine — so the image was reported as a local build and the pin
 *  check quietly did nothing for every full-parity user. A skipped check reads exactly like a passing one.
 *
 *  The ghcr-qualified digest wins when both are present and disagree (a machine can hold the same name
 *  from two registries; the published one is the one we pin against). Matching is on the exact repository
 *  name up to `@`, so `name-extra@…` never satisfies `name`. */
export function registryDigestFrom(repoDigests: string[], ghcrRepo: string, localImage: string): string | null {
  const bareName = localImage.split(":")[0];
  const digestFor = (repo: string): string | null => {
    const hit = repoDigests.find((d) => typeof d === "string" && d.slice(0, d.indexOf("@")) === repo);
    return hit ? hit.slice(hit.indexOf("@") + 1) : null;
  };
  return digestFor(ghcrRepo) ?? digestFor(bareName);
}

export function freshnessFor(local: string, ghcrRef: string | null, localDigest: string | null, pin: string | null): ImageFreshness {
  if (!ghcrRef) return { state: "unknown", detail: `${local} is a custom image — no published counterpart to compare` };
  if (!localDigest) return { state: "local", detail: `${local} was built locally (no registry digest to compare)` };
  if (!pin) return { state: "unpinned", detail: `this build pins no digest for ${local} — freshness not checked` };
  if (localDigest === pin) return { state: "current", detail: `matches the digest this harness version pins` };
  return {
    state: "stale",
    detail: `local ${local} is not the digest this harness version pins`,
    ghcrRef,
    // Digest-addressed, NOT the floating `:2`: once a newer revision is published, pulling `:2` still
    // would not equal an older pin, so a floating remedy never converges.
    pinnedRef: `${ghcrRef.split(":")[0]}@${pin}`,
  };
}

export interface DoctorCheck {
  id: string;
  title: string;
  status: Status;
  detail: string;
  remedy?: string;
  required: boolean; // does this check gate the exit code for the selected tier?
}

/** Injectable probe so the checks are unit-testable without a real Docker/agent/host. The default
 *  implementation uses the real runtime; tests pass a fake. */
export interface DoctorProbe {
  nodeMajor(): number;
  platform(): string;
  arch(): string;
  runtimeName(): string;
  runtimeAvailable(): boolean;
  runtimeDaemonUp(): boolean;
  limaAvailable(): boolean; // microvm (L2) only — `limactl` present (Lima / Apple Virtualization.framework)
  vmInstanceStatus(): string; // microvm (L2) only — `limactl list <instance> --format {{.Status}}` for the current baseline's derived Lima instance; surfaces whether `vm init` has provisioned it yet ("Running"/"Stopped"/"Absent")
  vmProvisioning(): string; // microvm (L2) only, asked only when the instance is Running — how far its provisioning got ("ready"/"pending"/"sealed"/"failed"; see lima.ts vmProvisioned)
  imageName(): string;
  imagePresent(): boolean;
  proxyImageName(): string;
  proxyImagePresent(): boolean;
  // `opts.parityMount` mirrors `hostAgentBinary`'s patch tolerance — passed by the hostloop/cowork tiers
  // ONLY, where this ELF is a non-executed parity mount into the bash sidecar (the binary actually
  // executed there is the native one, via `hostAgentBinary`). `note` is set only for a genuine parity-patch
  // substitution — never for a `COWORK_AGENT_BINARY` override or a major/minor fallback.
  // `kind` on a failure says WHY (`AgentBinaryError.kind`: "pruned" | "missing" | "override"), so the remedy
  // can fit the cause; absent for any other error (e.g. a sha mismatch).
  agentBinary(opts?: { parityMount?: boolean }): { ok: true; path: string; note?: string } | { ok: false; error: string; kind?: string };
  // Native macOS agent binary that `hostloop`/`cowork` spawn directly (distinct from the Linux ELF
  // `agentBinary()` resolves — see resolveHostAgentBinary in baseline.ts). Not meaningful for other tiers.
  // `note` is set when the resolved path came from a PATCH-tolerated staging-drift substitution (see
  // `classifyNativeStagingDrift`) — surfaced so the substitution is visible, not silent.
  // `kind` on a failure is the cause (see `nativeAgentRemedy`).
  hostAgentBinary(): { ok: true; path: string; note?: string } | { ok: false; error: string; kind?: NativeAgentFailure };
  hasToken(): boolean;
  // macOS only: is there a Claude Code OAuth credential in the login Keychain? Used purely to improve the
  // "no token" remedy — the harness injects only env/.env into the agent (never a Keychain credential),
  // at EVERY tier, so doctor points the user at .env. (doctor itself DOES read the Keychain — that is what
  // this probe is for — so the message must not claim otherwise.)
  hasKeychainToken(): boolean;
  // Path of `.credentials.json` in the config dir the protocol tier's agent reads (CLAUDE_CONFIG_DIR, else
  // ~/.claude) when it exists, else null — existence only, never read. OPTIONAL: a probe without it (every
  // test double) reports no file, so the check stays deterministic.
  configCredentialsFile?(): string | null;
  // When cwd is a git WORKTREE with no local ./.env but the main checkout has one, returns that .env path —
  // the gitignored .env doesn't travel to a worktree, a common "no token" first-run trap. null otherwise.
  worktreeEnv(): string | null;
  baseline(): { ok: true; version: string } | { ok: false; error: string };
  // Advisory only (never blocks doctor) — is `python3` on PATH? `lint` requires it. Optional so existing
  // test doubles don't need updating: when a probe doesn't implement it, doctor falls back to a real
  // PATH check (mirrors realProbe's implementation below).
  hasPython3?(): boolean;
  // Advisory (container/hostloop/cowork only): is the local pulled agent image the digest this build
  // pins? OFFLINE — the pin is read from `docker/agent-image.json`, so this no longer touches the network
  // at all; the only I/O is a local `image inspect`. OPTIONAL — omitted by test doubles so the check is
  // simply NOT run. A locally-BUILT image returns `local` (uncomparable), never a false "stale".
  imageFreshness?(): ImageFreshness;
}

/** Map a harness-published LOCAL image tag to its GHCR source ref, or null for a custom/overridden image.
 *  The harness resolves the unqualified local tag (`cowork-agent-base:2`), never the `ghcr.io/…` path — so
 *  a stale local image of that tag silently shadows the published one; the freshness probe compares them. */
export function ghcrRefFor(localImage: string): string | null {
  const known: Record<string, string> = {
    "cowork-agent-base:2": "ghcr.io/yaniv-golan/cowork-agent-base:2",
    "cowork-agent-full:2": "ghcr.io/yaniv-golan/cowork-agent-full:2",
  };
  return known[localImage] ?? null;
}

/** Package-root `docker build` line for the agent image — resolved relative to THIS file (works from a
 *  global install, not just a source checkout). Replaces a `build-image` command. */
export function agentBuildLine(runtime: string, image: string): string {
  const dockerfile = fileURLToPath(new URL("../../docker/Dockerfile.agent", import.meta.url));
  const pkgRoot = dirname(dirname(dockerfile)); // .../docker -> package root (the build context)
  return `${runtime} build --platform linux/arm64 -t ${image} -f ${dockerfile} ${pkgRoot}`;
}

/** Why the native agent did not resolve — `AgentBinaryError.kind` from `resolveHostAgentBinary`. */
export type NativeAgentFailure =
  "major-minor" | "build" | "missing-root" | "missing" | "unfinished" | "unusable-build" | "unknown-layout" | "override";

/** The note doctor shows on an `ok` native agent, naming any difference from the pin. Undefined for an
 *  exact, unambiguous match. Exported for tests. */
export function nativeDriftNote(d: NativeStagingDrift): string | undefined {
  const parts: string[] = [];
  const layout = d.layout === "nested" && d.foundBuild ? ` (build ${d.foundBuild})` : "";
  if (d.kind === "patch") parts.push(`patch-tolerated: pinned ${d.pinned}, using ${d.found}${layout}`);
  else if (d.kind === "build")
    parts.push(
      `fallback (COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1): pinned build ${d.pinnedBuild}, using ${d.foundBuild ?? "a flat install"} of ${d.found}`,
    );
  else if (d.kind === "major-minor")
    parts.push(`fallback (COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1): pinned ${d.pinned}, using ${d.found}${layout}`);
  else if (d.kind === "exact" && d.relocated)
    parts.push(
      d.layout === "nested"
        ? `pinned path uses the flat layout; the same version is staged at ${d.found}/${d.foundBuild}/` +
            (d.pinnedFilePresent ? ", which runs; the pinned flat file is also still present" : "")
        : `pinned build ${d.pinnedBuild} found as a flat install`,
    );
  if (d.hostArchUnpinned)
    parts.push(
      `no ${d.hostArchUnpinned.arch} build pinned (only ${d.hostArchUnpinned.pinnedArchs.join(", ")}): matched ${d.found} by version, build ${d.foundBuild ?? "(flat install)"}`,
    );
  if (d.others?.length)
    parts.push(`ambiguous: ${d.others.length + 1} builds of ${d.found}, using ${d.foundBuild ?? "the flat install"} (newest .verified)`);
  return parts.length ? parts.join("; ") : undefined;
}

const NO_NATIVE_LOCALLY =
  "Claude Desktop stages it locally; if nothing is staged here (for example because Claude runs on your organization's " +
  "infrastructure), set COWORK_HOST_AGENT_BINARY=<path> to a native agent binary";

/** docs/cli.md's platform table: Linux live is `container` only (microvm is Apple-VZ), Windows is replay/protocol. */
const PLATFORM_TABLE = "docs/cli.md#prerequisites-for-anything-above-protocol-fidelity";

/** The remedy for a native agent that did not resolve, per cause. Never "open Cowork once": wrong for a
 *  version mismatch, for a layout this harness cannot read, off macOS, and for an account whose Claude
 *  runs on its organization's infrastructure. Exported for tests. */
export function nativeAgentRemedy(kind: NativeAgentFailure | undefined, platform: string): string {
  if (kind === "override") return "fix or unset COWORK_HOST_AGENT_BINARY — it names a path that does not exist";
  // Off macOS there is no native agent and a Mach-O override cannot run, so the only remedy is another tier.
  if (platform !== "darwin")
    return `hostloop, and cowork when it resolves to host-loop, run the native macOS agent binary, which does not exist on ${platform} — use --tier ${platform === "linux" ? "container" : "protocol or replay"} (${PLATFORM_TABLE})`;
  switch (kind) {
    case "major-minor":
      return "set COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 to run the staged version, set COWORK_HOST_AGENT_BINARY=<path> to a saved copy of the pinned version's binary, or use a baseline that pins the staged version";
    case "build":
      return "set COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 to run the staged build of the same version, or COWORK_HOST_AGENT_BINARY=<path> to a saved copy of the pinned build";
    case "unfinished":
      return `Claude Desktop has not finished staging that build (it writes .verified last); it re-stages it the next time it prepares the agent. Or set COWORK_HOST_AGENT_BINARY=<path>`;
    case "unusable-build":
      return "a build dir is present but not a runnable verified build (the detail says why) — set COWORK_HOST_AGENT_BINARY=<path> to a native agent binary";
    case "unknown-layout":
      return "this Desktop stages the agent in a layout this harness version does not read — set COWORK_HOST_AGENT_BINARY=<path> to the staged binary, and upgrade cowork-harness";
    case "missing-root":
      return `no Claude Desktop agent staging dir on this machine. ${NO_NATIVE_LOCALLY}`;
    default:
      return `nothing runnable is staged. ${NO_NATIVE_LOCALLY}`;
  }
}

/** The remedy for the VM/container ELF, per cause. Exported for tests. */
export function agentRemedy(kind: string | undefined, parityMount: boolean): string {
  const base =
    kind === "pruned"
      ? "a Desktop update pruned the pinned ELF: recover and sha-verify that version, then set COWORK_AGENT_BINARY=<path> to it (docs/maintenance.md#recovering-an-old-agent-version); or set COWORK_HARNESS_ALLOW_AGENT_FALLBACK=1 to run the newest staged one; or repin baseline: to a version you have (docs/gotchas.md)"
      : kind === "override"
        ? "fix or unset COWORK_AGENT_BINARY — it names a path that does not exist"
        : "Claude Desktop stages the agent ELF on macOS (claude-code-vm/<ver>/claude); on Linux, in CI, or with nothing staged, set COWORK_AGENT_BINARY=<path> to a Linux ELF (docs/maintenance.md#recovering-an-old-agent-version) — put it in your .env so --dotenv covers it, like the token";
  return parityMount
    ? `${base} — note: on this tier the ELF is a non-executed parity mount, not the binary that actually runs (that's the native \`hostAgent\` check below)`
    : base;
}

export const realProbe: DoctorProbe = {
  nodeMajor: () => Number(process.versions.node.split(".")[0]),
  platform: () => process.platform,
  arch: () => process.arch,
  runtimeName: () => resolveContainerRuntime(),
  runtimeAvailable() {
    const r = spawnSync(this.runtimeName(), ["--version"], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  runtimeDaemonUp() {
    const r = spawnSync(this.runtimeName(), ["info"], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  limaAvailable() {
    const r = spawnSync(limaPath(), ["--version"], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  vmInstanceStatus() {
    try {
      return vmStatus(instanceName(loadBaseline("latest")));
    } catch (e) {
      return `unknown (${(e as Error).message.split("\n")[0]})`;
    }
  },
  vmProvisioning() {
    try {
      return vmProvisioned(instanceName(loadBaseline("latest")));
    } catch (e) {
      return `unknown (${(e as Error).message.split("\n")[0]})`;
    }
  },
  imageName: () => resolveAgentImage(),
  imagePresent() {
    const r = spawnSync(this.runtimeName(), ["image", "inspect", this.imageName()], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  proxyImageName: () => resolveProxyImage(),
  proxyImagePresent() {
    const r = spawnSync(this.runtimeName(), ["image", "inspect", this.proxyImageName()], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  agentBinary(opts?: { parityMount?: boolean }) {
    try {
      const baseline = loadBaseline("latest");
      const path = resolveAgentBinary(baseline, opts);
      // Only label the note "patch-tolerated" for a GENUINE parity patch substitution — NOT for a
      // COWORK_AGENT_BINARY override (arbitrary path; version fields would be garbage) and NOT for a
      // major/minor COWORK_HARNESS_ALLOW_AGENT_FALLBACK substitution (not patch-only). Mirrors the
      // hostAgent probe's rule that its note can never disagree with what the resolver actually did.
      const pinned = (baseline.agentBinary?.stagedPath ?? "").replace(/^~(?=$|\/)/, homedir());
      const isParityPatch =
        !!opts?.parityMount &&
        !!pinned &&
        !process.env.COWORK_AGENT_BINARY &&
        resolve(pinned) !== path &&
        isPatchBump(basename(dirname(pinned)), basename(dirname(path)));
      const note = isParityPatch
        ? `parity mount: patch-tolerated (pinned ${basename(dirname(pinned))}, using ${basename(dirname(path))})`
        : undefined;
      return { ok: true as const, path, note };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message, ...(e instanceof AgentBinaryError ? { kind: e.kind } : {}) };
    }
  },
  hostAgentBinary() {
    try {
      const baseline = loadBaseline("latest");
      const path = resolveHostAgentBinary(baseline);
      // Same classifier the resolver used internally — so doctor's note can never disagree with what
      // resolveHostAgentBinary actually did. An override bypasses the classifier entirely, so it gets no
      // drift note (the drift on disk is not what runs).
      const note = process.env.COWORK_HOST_AGENT_BINARY ? undefined : nativeDriftNote(classifyNativeStagingDrift(baseline));
      return { ok: true, path, note };
    } catch (e) {
      return { ok: false, error: (e as Error).message, ...(e instanceof AgentBinaryError ? { kind: e.kind as NativeAgentFailure } : {}) };
    }
  },
  hasToken: () => !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  // Read-only presence probe (macOS only). `-w` is deliberately OMITTED so the secret is never printed/
  // captured — we only care about the exit status (0 = a "Claude Code-credentials" entry exists). A locked
  // keychain returns non-zero → treated as "absent" (best-effort hint; harmless false-negative).
  hasKeychainToken: () => {
    if (process.platform !== "darwin") return false;
    const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials"], { stdio: "ignore" });
    return r.status === 0;
  },
  configCredentialsFile: () => {
    const f = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
    return existsSync(f) ? f : null;
  },
  worktreeEnv: () => {
    if (existsSync(join(process.cwd(), ".env"))) return null; // a local .env exists → not the worktree trap
    const gitDir = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" });
    const commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" });
    if (gitDir.status !== 0 || commonDir.status !== 0) return null; // not a git repo
    const gd = resolve(gitDir.stdout.trim());
    const cd = resolve(commonDir.stdout.trim());
    if (gd === cd) return null; // not a worktree (git-dir === common-dir in the main checkout)
    const mainEnv = join(dirname(cd), ".env"); // common-dir is <main>/.git → its parent is the main checkout
    return existsSync(mainEnv) ? mainEnv : null;
  },
  baseline() {
    try {
      return { ok: true, version: loadBaseline("latest").appVersion };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  hasPython3() {
    const r = spawnSync("python3", ["--version"], { stdio: "ignore", timeout: 5000 });
    return !r.error && r.status === 0;
  },
  imageFreshness(): ImageFreshness {
    const runtime = this.runtimeName();
    const local = this.imageName();
    const ghcrRef = ghcrRefFor(local);
    if (!ghcrRef) return freshnessFor(local, null, null, null);
    const repo = ghcrRef.split(":")[0]; // ghcr.io/owner/name (RepoDigests key on the digest side)

    // Local registry digest — present ONLY on a pulled image; a locally-built image has an empty RepoDigests.
    const li = spawnSync(runtime, ["image", "inspect", "--format", "{{json .RepoDigests}}", local], {
      encoding: "utf8",
      timeout: 5000,
    });
    // I/O failure is NOT "built locally" — a stopped daemon must report `unknown`, not a confident `local`.
    if (li.error || li.status !== 0) return { state: "unknown", detail: "could not inspect the local image" };
    let localDigest: string | null = null;
    try {
      const digests: unknown = JSON.parse((li.stdout || "").trim() || "[]");
      if (Array.isArray(digests)) {
        localDigest = registryDigestFrom(
          digests.filter((d): d is string => typeof d === "string"),
          repo,
          local,
        );
      }
    } catch {
      /* fall through → treated as a local build */
    }
    // Compared against the digest this build PINS, read from disk. The previous implementation asked GHCR
    // what `:2` points at *now*, which needed network + buildx (degrading to `unknown` offline) and could
    // only ever establish that two digests differ — never which one this harness expected.
    return freshnessFor(local, ghcrRef, localDigest, pinnedDigestFor(local));
  },
};

/** The agent-credential check for one tier — the `token` row of `runDoctorChecks`, and the ONLY credential
 *  detector: `eval` refuses before its first run on exactly this decision, so the two can never disagree
 *  about a tier. Refuse on `status === "fail"`; `warn` (protocol with a Keychain login) is runnable. */
export function tokenCheck(tier: Tier, probe: DoctorProbe = realProbe): DoctorCheck {
  const plat = probe.platform();
  const token = probe.hasToken();
  // First-run trap: a Claude Code login writes the OAuth token to the macOS Keychain, but the
  // harness passes only env / .env to the agent. If the env is empty BUT a Keychain credential
  // exists, the generic "set a token" remedy is a dead end; point the user straight at the .env copy instead.
  const keychainOnly = !token && plat === "darwin" && probe.hasKeychainToken();
  // Worktree trap: a git worktree's gitignored ./.env is absent there, so a token in the main checkout's
  // .env doesn't apply. Point at it via --dotenv. (Keychain takes precedence — it's the "you have a token,
  // just unreadable in-Docker" case.)
  const worktreeEnv = !token && !keychainOnly ? probe.worktreeEnv() : null;
  // PROTOCOL ONLY: this tier deliberately keeps the user's REAL CLAUDE_CONFIG_DIR when no API key is
  // present (protocol.ts:88-97) precisely because "a fresh CLAUDE_CONFIG_DIR breaks OAuth". So a
  // Keychain-only macOS user CAN run protocol — the agent authenticates from local login state, and
  // failing them here is a false negative on the one tier that needs no Docker and no staged agent.
  // Measured live 2026-07-25 (agent 2.1.217, env scrubbed of all three token vars): default config dir
  // => authenticated; fresh managed config dir => "Not logged in · Please run /login". EVERY other tier
  // passes a managed configDir (argv.ts:179 host-native, :142 guest), which severs self-sourcing — so
  // the token is genuinely required there and this relaxation must not spread.
  // `warn`, not `ok`: the probe proves a Keychain credential EXISTS, not that the real config dir's
  // login state is still valid. Non-blocking because readiness gates on `status === "fail"` (see the
  // `blocking` filter), so `required: true` is preserved and the caveat still prints.
  // The same self-sourcing from a FILE: where Claude Code keeps its login in `<config dir>/.credentials.json`
  // (Linux, or any host without a Keychain), protocol's real config dir carries it too. Asked only at
  // protocol, and an existence check — the file is never read.
  const credsFile = !token && !keychainOnly && tier === "protocol" ? (probe.configCredentialsFile?.() ?? null) : null;
  const protocolSelfSourced = tier === "protocol" && (keychainOnly || credsFile !== null);
  return {
    id: "token",
    title: "Auth token",
    status: token ? "ok" : protocolSelfSourced ? "warn" : "fail",
    detail: token
      ? "found (env / .env)"
      : credsFile !== null
        ? `no env / .env token, but ${credsFile} exists — protocol keeps your REAL CLAUDE_CONFIG_DIR (no API key present), so the agent can authenticate from that login`
        : protocolSelfSourced
          ? "no env / .env token, but a 'Claude Code-credentials' Keychain entry exists — protocol keeps your REAL CLAUDE_CONFIG_DIR (no API key present), so the agent can authenticate from local login state"
          : keychainOnly
            ? "found a 'Claude Code-credentials' Keychain entry, but cowork-harness does not pass a Keychain credential to the agent"
            : worktreeEnv
              ? "no token in this git worktree (its ./.env is gitignored, so it's absent here)"
              : "no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN",
    remedy: token
      ? undefined
      : protocolSelfSourced
        ? "likely fine as-is at this tier — if a run fails with 'Not logged in', put the token in ./.env: echo CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) >> .env (required for container/microvm/hostloop, which use a managed CLAUDE_CONFIG_DIR)"
        : keychainOnly
          ? "copy your Keychain token into ./.env — cowork-harness injects only env / .env into the agent, at every tier: echo CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) >> .env — or, if the token is already in another file, point at it: cowork-harness --dotenv <path> <cmd> (doctor honors --dotenv too)"
          : worktreeEnv
            ? `the main checkout has a .env — point at it: cowork-harness --dotenv ${worktreeEnv} <cmd> (or set CLAUDE_CODE_OAUTH_TOKEN)`
            : "export CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) (or set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN), put it in ./.env, or point at another file: cowork-harness --dotenv <path> <cmd>",
    required: true, // required for every tier doctor validates — each of those tiers calls a real model when actually run; only a committed-cassette replay needs none (and replay skips doctor)
  };
}

/** What to say when a run ended because the agent could not authenticate (eval's `auth` termination rule): which
 *  credentials the agent reads at this tier and from where, in order, what doctor's own check sees now (`check`, the
 *  `token` row for the same tier), and how to supply one. Variable NAMES only — never a value. `env` is the
 *  harness's process env, the one every source below is resolved into. */
export function authFailureHint(tier: Tier, check: DoctorCheck, env: NodeJS.ProcessEnv): string {
  // runtimeAuthEnv (src/runtime/host-env.ts) passes CLAUDE_CODE_OAUTH_TOKEN, else ANTHROPIC_API_KEY, at every tier but
  // protocol; protocol hands the agent the operator's env, and without a managed config dir its own login too.
  const vars =
    tier === "protocol"
      ? "CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (else, without a managed config dir only, the Claude Code login in your config dir)"
      : "CLAUDE_CODE_OAUTH_TOKEN, else ANTHROPIC_API_KEY";
  const sources =
    "each looked up in the process environment, then --dotenv <path>, then ./.env, then <install>/.env (the first that sets it wins)";
  const authTokenOnly = tier !== "protocol" && !!env.ANTHROPIC_AUTH_TOKEN && !env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY;
  const now = authTokenOnly
    ? `ANTHROPIC_AUTH_TOKEN is set, but at fidelity ${tier} only CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY reach the agent: put the token in CLAUDE_CODE_OAUTH_TOKEN`
    : check.status === "ok"
      ? "a credential is set, so the agent rejected it: it may be expired or revoked — mint a new one with `claude setup-token`"
      : `${check.detail}${check.remedy ? `. Fix: ${check.remedy}` : ""}`;
  return `the agent could not authenticate. At fidelity ${tier} the agent takes ${vars}, ${sources}. Now: ${now}. Check with: cowork-harness doctor --tier ${tier}`;
}

/** Pure check list for the selected tier. Live-only prereqs (`runtime`/`image`/`agent`) are reported as
 *  `skip` (not required) on `protocol`. `os` is informational (warn) except `microvm`, which hard-requires
 *  macOS arm64 (Apple's hypervisor). */
export function runDoctorChecks(tier: Tier, probe: DoctorProbe = realProbe): DoctorCheck[] {
  const live = isLive(tier);
  const checks: DoctorCheck[] = [];

  const node = probe.nodeMajor();
  // Floor tracks SUPPORTED Node, not the oldest that happens to run: 20 reached end-of-life on
  // 2026-04-30 and receives no security patches, so reporting it `ok` told users an unsupported
  // runtime was fine. 22 is the Maintenance-LTS line and matches the agent sandbox's own pin.
  // Keep this in lockstep with package.json `engines.node` — a test asserts they agree.
  checks.push({
    id: "node",
    title: "Node ≥ 22",
    status: node >= 22 ? "ok" : "fail",
    detail: `node ${process.versions.node}`,
    remedy: node >= 22 ? undefined : "install Node 22+ (https://nodejs.org) — Node 20 is end-of-life",
    required: true,
  });

  const plat = probe.platform();
  const arch = probe.arch();
  const macArm = plat === "darwin" && arch === "arm64";
  checks.push({
    id: "os",
    title: "OS / arch",
    status: macArm ? "ok" : tier === "microvm" ? "fail" : "warn",
    detail: `${plat}/${arch}`,
    remedy: macArm
      ? undefined
      : tier === "microvm"
        ? "microvm needs macOS Apple Silicon (Apple Virtualization.framework); use `container` instead"
        : plat === "win32"
          ? "Windows is not a supported host for the live tiers — use macOS Apple Silicon, or the token-free `replay`"
          : "best on macOS arm64; other hosts may need emulation, and `sync`/`microvm` are macOS-arm64 only",
    required: tier === "microvm",
  });

  // This check is shared by every live tier, but its meaning differs by tier. On container/microvm the
  // staged ELF IS the executed agent (bind-mounted into the sandbox guest), so resolution stays strict — a
  // pruned pin hard-fails. On hostloop — and on cowork ONLY when it resolves to host-loop (see
  // `coworkIsHostLoop` below) — the executed agent is the NATIVE macOS binary (see the `hostAgent` check
  // below); this ELF is only bind-mounted into the bash sidecar as a non-executed parity mount, so a pruned
  // pin there auto-accepts a patch-newer sibling (`parityMount: true`) instead of blocking, mirroring
  // `hostAgent`'s own patch tolerance. A cowork baseline that resolves to VM-loop executes this ELF
  // directly, so it stays strict — same as container/microvm.
  const agentCheck = (parityMount: boolean): DoctorCheck => {
    const agent = probe.agentBinary({ parityMount });
    // Surface the ELF's sha256 provenance so setup is self-explaining (a hard mismatch already fails the
    // resolve above and lands in agent.error). Best-effort re-hash — doctor is a read-only truth check.
    let shaNote = "";
    if (agent.ok) {
      try {
        const ab = loadBaseline("latest").agentBinary;
        if (ab?.sha256) {
          const match = sha256File(agent.path) === ab.sha256;
          shaNote = `  [sha256 ${match ? "✓" : "✗"} vs baseline, ${ab.shaProvenance ?? "unknown"}]`;
        }
      } catch {
        /* provenance is a hint; never let it fail the check */
      }
    }
    // A parity-patch substitution stays `ok` (it's safe — the ELF is never executed there), but the note
    // names the pinned-vs-found versions so the substitution is visible rather than silent.
    const parityNote = agent.ok && agent.note ? `  [${agent.note}]` : "";
    return {
      id: "agent",
      title: parityMount ? "Staged agent binary (VM ELF, parity mount)" : "Staged agent binary (VM/container ELF)",
      status: agent.ok ? "ok" : "fail",
      detail: agent.ok ? agent.path + shaNote + parityNote : agent.error.split("\n")[0],
      remedy: agent.ok ? undefined : agentRemedy(agent.kind, parityMount),
      required: true,
    };
  };

  const runtime = probe.runtimeName();
  if (!live) {
    checks.push({ id: "runtime", title: "Container runtime", status: "skip", detail: `not needed for ${tier}`, required: false });
    checks.push({ id: "image", title: "Agent image", status: "skip", detail: `not needed for ${tier}`, required: false });
    checks.push({
      id: "agent",
      title: "Staged agent binary (VM/container ELF)",
      status: "skip",
      detail: `not needed for ${tier}`,
      required: false,
    });
  } else if (tier === "microvm") {
    // L2 runs on Lima + Apple Virtualization.framework — NOT Docker. Check `limactl`, not the container
    // runtime / agent image / egress-proxy image (the microVM uses its own rootfs and a host-side proxy).
    const limaOk = probe.limaAvailable();
    checks.push({
      id: "lima",
      title: "Lima (limactl)",
      status: limaOk ? "ok" : "fail",
      detail: limaOk ? `${limaPath()} found` : `limactl not found (${limaPath()})`,
      remedy: limaOk ? undefined : "install Lima (`brew install lima`) or set COWORK_LIMACTL=<path>",
      required: true,
    });
    const vmStatusStr = limaOk ? probe.vmInstanceStatus() : "Absent";
    // `Running` only means the guest booted: a first boot cut off by `limactl start`'s timeout is Running
    // with provisioning unfinished, so a Running instance is asked how far it got. A Stopped one cannot be
    // asked; a run re-checks it when it starts it.
    const provisioning = limaOk && vmStatusStr === "Running" ? probe.vmProvisioning() : undefined;
    const vmCheck = ((): { status: "ok" | "warn" | "skip"; detail: string; remedy?: string } => {
      if (!limaOk) return { status: "skip", detail: "not checked — limactl missing" };
      if (vmStatusStr === "Stopped") return { status: "ok", detail: "instance stopped — readiness is checked when a run starts it" };
      if (vmStatusStr !== "Running")
        return {
          status: "warn",
          detail: `no provisioned instance yet (status: ${vmStatusStr})`,
          remedy:
            "run `cowork-harness vm init` once to pre-provision (a live microvm run self-provisions too, just with first-run VM-boot latency)",
        };
      if (provisioning === "ready") return { status: "ok", detail: "instance running — provisioned" };
      if (provisioning === "pending")
        return {
          status: "warn",
          detail: "instance running — still provisioning",
          remedy: "wait for it (a run waits up to COWORK_VM_PROVISION_TIMEOUT_S), then re-run doctor",
        };
      if (provisioning === "sealed")
        return {
          status: "warn",
          detail: "instance running — firewalled before provisioning finished",
          remedy: "the next microvm run restarts it once to recover; if that fails, run `cowork-harness vm delete`",
        };
      if (provisioning === "failed")
        return {
          status: "warn",
          detail: "instance running — provisioning ended without the agent on PATH",
          remedy: "run `cowork-harness vm delete`, then retry",
        };
      return { status: "warn", detail: `instance running — provisioning state ${provisioning ?? "unknown"}` };
    })();
    checks.push({
      id: "vm-instance",
      title: "Lima VM instance (vm init)",
      status: vmCheck.status,
      detail: vmCheck.detail,
      remedy: vmCheck.remedy,
      required: false,
    });
    checks.push(agentCheck(false));
  } else {
    const avail = probe.runtimeAvailable();
    const up = avail && probe.runtimeDaemonUp();
    checks.push({
      id: "runtime",
      title: "Container runtime",
      status: up ? "ok" : "fail",
      detail: avail ? (up ? `${runtime} daemon reachable` : `${runtime} found but daemon not reachable`) : `${runtime} not found`,
      remedy: up
        ? undefined
        : avail
          ? `start ${runtime} (the daemon isn't responding to \`${runtime} info\`)`
          : `install ${runtime} (or set COWORK_CONTAINER_RUNTIME)`,
      required: true,
    });

    const image = probe.imageName();
    const present = up && probe.imagePresent();
    checks.push({
      id: "image",
      title: "Agent image",
      status: present ? "ok" : up ? "fail" : "skip",
      detail: present
        ? `${image} present — lean core; OCR / PDF-table skills need the full-parity image (--build-arg COWORK_FULL_PARITY=1)`
        : up
          ? `${image} missing`
          : `(skipped — ${runtime} not reachable)`,
      remedy: present || !up ? undefined : `build it: ${agentBuildLine(runtime, image)}`,
      required: up, // only gate on the image once the runtime is actually reachable
    });

    // `cowork` doesn't pin a loop mode itself — it's resolved from the synced baseline gate at run time
    // (decideLoopFromBaseline; see execute.ts's `cowork` dispatch). Computed here, BEFORE the `agent` check,
    // so the VM-ELF parity-mount tolerance mirrors the runtime EXACTLY: `hostloop` is unconditionally
    // host-loop (always tolerant), but `cowork` is tolerant ONLY when it resolves to host-loop on the
    // synced baseline. A cowork baseline that resolves to VM-loop executes this ELF directly — same strict
    // path as `container` — so tolerating a pruned pin there would be a doctor false-green (ok) against a
    // real run that hard-fails. Resolved once and reused below for the `cowork-loop` note (DRY).
    let coworkLoop: "host" | "vm" | null = null;
    if (tier === "cowork") {
      try {
        coworkLoop = decideLoopFromBaseline(loadBaseline("latest"));
      } catch {
        coworkLoop = null; // best-effort; the agent check below falls back to the tolerant default
      }
    }
    const coworkIsHostLoop = coworkLoop !== "vm"; // unknown (null) defaults tolerant — hostloop is the current-baseline default

    // One predicate drives BOTH native-binary and ELF facts. hostloop — and cowork resolving to host-loop —
    // run the NATIVE macOS binary as the agent and bind-mount the VM ELF only for parity; a cowork baseline
    // resolving to VM-loop runs the ELF itself (like container) and does NOT use the native binary. So this
    // gates the ELF parity tolerance (`agent` check) AND whether the native `hostAgent` binary is required:
    // requiring it on a VM-loop cowork rig would be the mirror false-NOT-ready of the `agent` false-green.
    const runsViaHostLoop = tier === "hostloop" || (tier === "cowork" && coworkIsHostLoop);

    // Advisory image-freshness (never blocks): only when the image is present AND the probe implements it
    // (test doubles omit it → hermetic). Compares a PULLED local image to the current published GHCR `:2`;
    // a locally-built or uncomparable image stays a quiet `skip`, only a genuine drift `warn`s.
    if (present && probe.imageFreshness) {
      const f = probe.imageFreshness();
      checks.push({
        id: "image-freshness",
        title: "Agent image freshness",
        status: f.state === "current" ? "ok" : f.state === "stale" ? "warn" : "skip",
        detail: f.detail,
        remedy:
          f.state === "stale" ? `re-pull to match: ${runtime} pull ${f.pinnedRef} && ${runtime} tag ${f.pinnedRef} ${image}` : undefined,
        required: false,
      });
    }

    checks.push(agentCheck(runsViaHostLoop));

    if (tier === "hostloop" || tier === "cowork") {
      const hostAgent = probe.hostAgentBinary();
      // A patch-tolerated staging-drift substitution stays `ok` (it's safe — the native binary has no
      // sha256 pin), but the note names the pinned-vs-found versions so the substitution is visible.
      const note = hostAgent.ok && hostAgent.note ? `  [${hostAgent.note}]` : "";
      // The native binary is REQUIRED only when the run actually executes it (hostloop, or cowork resolving
      // to host-loop). A cowork baseline resolving to VM-loop runs the ELF, not this binary, so a missing
      // native binary must NOT block `cowork` there — mirror of the `agent` check's tolerance gate above.
      const naNote = runsViaHostLoop ? "" : "  [not the executed agent at this resolution — cowork runs the ELF in VM-loop]";
      checks.push({
        id: "hostAgent",
        title: "Staged native agent binary (hostloop)",
        status: hostAgent.ok ? "ok" : "fail",
        detail: hostAgent.ok ? hostAgent.path + note : hostAgent.error.split("\n")[0] + naNote,
        remedy: hostAgent.ok ? undefined : nativeAgentRemedy(hostAgent.kind, plat),
        required: runsViaHostLoop,
      });
    }

    // Informational only (never blocks): reuses `coworkLoop`, resolved once above, so this note can never
    // disagree with the tolerance the `agent` check just applied.
    if (tier === "cowork") {
      const loopDetail =
        coworkLoop === "host"
          ? "resolves to hostloop on this baseline — the VM ELF above is a non-executed parity mount; the native binary (`hostAgent`) is what actually runs"
          : coworkLoop === "vm"
            ? "resolves to VM-loop on this baseline — the whole agent runs in the sandbox, same as `container`/`microvm`, so the `agent` check above is STRICT (no parity tolerance)"
            : "loop mode resolves from the synced baseline gate at run time (see the `agent`/`hostAgent` checks above)";
      checks.push({
        id: "cowork-loop",
        title: "Cowork loop resolution",
        status: "ok",
        detail: loopDetail,
        required: false,
      });
    }

    // Egress proxy image — informational, never blocking: the egress sidecar builds it on the fly
    // (ensureProxyImage) when absent, so report status but don't gate the verdict on it.
    const proxy = probe.proxyImageName();
    const proxyPresent = up && probe.proxyImagePresent();
    checks.push({
      id: "proxy",
      title: "Egress proxy image",
      status: proxyPresent ? "ok" : "skip",
      detail: !up
        ? `(skipped — ${runtime} not reachable)`
        : proxyPresent
          ? `${proxy} present`
          : `${proxy} absent — built automatically on first run`,
      required: false,
    });
  }

  checks.push(tokenCheck(tier, probe));

  const bl = probe.baseline();
  checks.push({
    id: "baseline",
    title: "Platform baseline",
    status: bl.ok ? "ok" : "fail",
    detail: bl.ok ? `desktop-${bl.version}` : bl.error.split("\n")[0],
    remedy: bl.ok ? undefined : "run `cowork-harness sync` (macOS) or restore baselines/desktop-*.json",
    required: true,
  });

  // Advisory-only — `lint` needs python3, but doctor's own checks (record/replay/run) don't, so a miss
  // never blocks any tier.
  const python3Ok = (probe.hasPython3 ?? realProbe.hasPython3!)();
  checks.push({
    id: "python3",
    title: "python3 (for `lint`)",
    status: python3Ok ? "ok" : "warn",
    detail: python3Ok ? "python3 found on PATH" : "python3 not found on PATH",
    remedy: python3Ok ? undefined : "install python3 — only needed for `cowork-harness lint`",
    required: false,
  });

  return checks;
}

const GLYPH: Record<Status, string> = { ok: "✓", fail: "✗", warn: "!", skip: "·" };

/** `cowork-harness doctor [--tier <t>] [--output-format json]` — read-only prerequisite check. */
export function cmdDoctor(args: string[]): void {
  let p;
  try {
    p = parseArgs(
      args,
      withCommandGlobals({
        values: ["--tier", "--output-format"],
        enums: {
          "--tier": [...FIDELITY_TIERS],
          "--output-format": ["text", "json"],
        },
      }),
    );
  } catch (e) {
    fail("doctor", "usage", (e as Error).message, undefined, isJsonOutput(args));
  }
  applyParsedCommandGlobals("doctor", p, isJsonOutput(args));
  const tier = (p.options["--tier"] as Tier) ?? "container";
  const json = isJsonOutput(args);

  // reject unexpected positional arguments.
  if (p.positionals.length > 0) {
    fail("doctor", "usage", `unexpected arguments: ${p.positionals.join(" ")}`, undefined, isJsonOutput(args));
  }

  const checks = runDoctorChecks(tier);
  const blocking = checks.filter((c) => c.required && c.status === "fail");
  const ok = blocking.length === 0;

  if (json) {
    // Routed through the shared envelope (schema/doctor.json, SPEC §11.x/§12) so the completed-probe
    // shape carries `error: null` like every other command's normal-path JSON — a consumer branching
    // on `error !== null` sees a consistent frame across `doctor` and the rest of the CLI.
    out(jsonPayloadEnvelope("doctor", ok, { tier, checks }));
  } else {
    log(`cowork-harness doctor — tier: ${tier}\n`);
    for (const c of checks) {
      log(`  ${GLYPH[c.status]} ${c.title} — ${c.detail}`);
      if (c.remedy && (c.status === "fail" || c.status === "warn")) log(`      → ${c.remedy}`);
    }
    log(
      ok
        ? `\n✓ ready for \`${tier}\`${checks.some((c) => c.status === "warn") ? " (with warnings)" : ""}`
        : `\n✗ not ready for \`${tier}\` — ${blocking.length} blocking issue(s): ${blocking.map((c) => c.id).join(", ")}`,
    );
  }
  return process.exit(ok ? 0 : 1);
}
