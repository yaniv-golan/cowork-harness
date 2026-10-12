import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The device container's image: the resolved agent image plus libcwh-nodelete, built locally from this directory
 *  on first use and never published (docker/device/Dockerfile). */
export const DEVICE_IMAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docker", "device");

/** Every file the image is built from, in a fixed order. */
const SOURCES = ["Dockerfile", "nodelete.c", "ld.so.preload"] as const;

/** sha256 over the image's source files (name and bytes). `override` replaces a file's contents, for tests. */
export function deviceImageSourceHash(override: Partial<Record<(typeof SOURCES)[number], string>> = {}): string {
  const h = createHash("sha256");
  for (const f of SOURCES) {
    const body = override[f] ?? readFileSync(join(DEVICE_IMAGE_DIR, f), "utf8");
    h.update(`${f}\0${Buffer.byteLength(body)}\0`).update(body);
  }
  return h.digest("hex");
}

/** The tag names what the image was built from, so a changed source or a re-pulled base gets a new image and an
 *  unchanged one is reused. A fixed tag checked only for existence would keep serving a stale image. */
export function deviceImageTag(sourceHash: string, baseImageId: string): string {
  return `cowork-device:1-${createHash("sha256").update(`${sourceHash}\0${baseImageId}`).digest("hex").slice(0, 12)}`;
}

/** An image's ID, or null when it is absent. */
export type ImageInspect = (ref: string) => string | null;

export function dockerImageId(runner: string): ImageInspect {
  return (ref) => {
    const r = spawnSync(runner, ["image", "inspect", "-f", "{{.Id}}", ref], { encoding: "utf8", timeout: 30_000 });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  };
}

/** Whether the device image for `baseRef` is built (doctor's row). `absent` is not an error: the next bridge run
 *  builds it. */
export function deviceImageStatus(
  baseRef: string,
  inspect: ImageInspect,
): { state: "current" | "absent"; tag: string } | { state: "no-base" } {
  const baseId = inspect(baseRef);
  if (!baseId) return { state: "no-base" };
  const tag = deviceImageTag(deviceImageSourceHash(), baseId);
  return { state: inspect(tag) ? "current" : "absent", tag };
}

/** The device image's ID for `baseRef`, building it first when absent. The caller runs the container by this ID,
 *  so a concurrent build that retags cannot change what this run starts. Build output goes to stderr, never stdout
 *  (a JSON-output run owns stdout). */
export function ensureDeviceImage(
  runner: string,
  baseRef: string,
  inspect: ImageInspect = dockerImageId(runner),
): { imageId: string; tag: string } | { error: string } {
  const baseId = inspect(baseRef);
  if (!baseId) return { error: `the agent image ${baseRef} is not present, so the device image cannot be built on it` };
  const sourceHash = deviceImageSourceHash();
  const tag = deviceImageTag(sourceHash, baseId);
  const have = inspect(tag);
  if (have) return { imageId: have, tag };
  process.stderr.write(`[device] building ${tag} on ${baseRef} (first device_bridge run on this image; needs Docker Hub and apt)\n`);
  const build = spawnSync(
    runner,
    [
      "build",
      "--platform",
      "linux/arm64",
      "--build-arg",
      `BASE=${baseRef}`,
      "--label",
      `cwh.device.src=${sourceHash}`,
      "--label",
      `cwh.device.base=${baseId}`,
      "-t",
      tag,
      DEVICE_IMAGE_DIR,
    ],
    { stdio: ["ignore", 2, 2], timeout: 900_000 },
  );
  if (build.status !== 0)
    return {
      error: `building the device image ${tag} failed (exit ${build.status ?? build.signal}); it needs Docker Hub (ubuntu:22.04) and apt`,
    };
  const built = inspect(tag);
  return built ? { imageId: built, tag } : { error: `the device image ${tag} was built but cannot be found` };
}
