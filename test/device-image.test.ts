// The device image is built locally on first use, from docker/device/, on top of the resolved agent image. Its tag
// is derived from what it is built from, so a changed shim source or a re-pulled base gets a new image, and an
// unchanged one is reused; the run then starts it by image ID, so a concurrent rebuild cannot swap it underneath.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deviceImageSourceHash, deviceImageTag, deviceImageStatus, DEVICE_IMAGE_DIR } from "../src/runtime/device-image.js";

describe("deviceImageTag", () => {
  it("names the source and the base image it was built from", () => {
    const t = deviceImageTag("a".repeat(64), "sha256:" + "b".repeat(64));
    expect(t).toMatch(/^cowork-device:1-[0-9a-f]{12}$/);
    expect(deviceImageTag("a".repeat(64), "sha256:" + "c".repeat(64))).not.toBe(t);
    expect(deviceImageTag("d".repeat(64), "sha256:" + "b".repeat(64))).not.toBe(t);
    expect(deviceImageTag("a".repeat(64), "sha256:" + "b".repeat(64))).toBe(t);
  });
});

describe("deviceImageSourceHash", () => {
  it("covers the Dockerfile, the shim source and the preload file", () => {
    const files = ["Dockerfile", "nodelete.c", "ld.so.preload"];
    const h = deviceImageSourceHash();
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(deviceImageSourceHash({ "nodelete.c": "changed" })).not.toBe(h);
    for (const f of files) expect(deviceImageSourceHash({ [f]: readFileSync(join(DEVICE_IMAGE_DIR, f), "utf8") + " " })).not.toBe(h);
  });
});

describe("the device image recipe", () => {
  const dockerfile = readFileSync(join(DEVICE_IMAGE_DIR, "Dockerfile"), "utf8");
  it("compiles against the same pinned base as the agent image, so glibc matches", () => {
    const agent = readFileSync(join(import.meta.dirname, "..", "docker", "Dockerfile.agent"), "utf8");
    const pin = /ubuntu:22\.04@sha256:[0-9a-f]{64}/;
    expect(dockerfile.match(pin)?.[0]).toBe(agent.match(pin)?.[0]);
  });
  it("installs the preload file by COPY (root-owned; the base image's last USER is not root)", () => {
    expect(dockerfile).toMatch(/^COPY ld\.so\.preload \/etc\/ld\.so\.preload$/m);
    expect(readFileSync(join(DEVICE_IMAGE_DIR, "ld.so.preload"), "utf8")).toBe("/opt/cowork/lib/libcwh-nodelete.so\n");
  });
});

describe("deviceImageStatus (doctor's row)", () => {
  it("current, absent, or the base itself missing", () => {
    const inspect = (have: Record<string, string>) => (ref: string) => have[ref] ?? null;
    const base = "cowork-agent-base:2";
    const baseId = "sha256:" + "e".repeat(64);
    const tag = deviceImageTag(deviceImageSourceHash(), baseId);
    expect(deviceImageStatus(base, inspect({ [base]: baseId, [tag]: "sha256:1" }))).toEqual({ state: "current", tag });
    expect(deviceImageStatus(base, inspect({ [base]: baseId }))).toEqual({ state: "absent", tag });
    expect(deviceImageStatus(base, inspect({}))).toEqual({ state: "no-base" });
  });
});
