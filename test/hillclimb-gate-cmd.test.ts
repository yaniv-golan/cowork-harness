// `hillclimb run --gate-cmd`: the real spawn — a throwaway copy, the two variables, the timeout's group kill, the tail cap.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATE_TAIL_BYTES, gateFailureText, runGateCommand } from "../src/hillclimb/gate-cmd.js";

let snap: string;
let scratch: string;
beforeEach(() => {
  snap = realpathSync(mkdtempSync(join(tmpdir(), "gate-snap-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "gate-scratch-")));
  writeFileSync(join(snap, "SKILL.md"), "original\n");
});
afterEach(() => {
  rmSync(snap, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("runGateCommand", () => {
  it("passes on exit 0, with both variables set and the cwd a copy of the snapshot", async () => {
    const out = join(scratch, "env.txt");
    const g = await runGateCommand({
      cmd: `printf '%s\\n%s\\n%s\\n' "$COWORK_HARNESS_VARIANT_DIR" "$COWORK_HARNESS_VARIANT_ID" "$(pwd -P)" > '${out}'; cat SKILL.md`,
      snapshot: snap,
      variant: "v2",
      timeoutS: 30,
    });
    expect(g).toMatchObject({ ok: true, code: 0, timedOut: false });
    const [dir, id, cwd] = readFileSync(out, "utf8").trim().split("\n");
    expect(id).toBe("v2");
    // The variable names the cwd (macOS's tmpdir is a /var → /private/var link, so compare the tail).
    expect(dir).toMatch(/cowork-harness-gate-[^/]+\/variant$/);
    expect(cwd.endsWith(dir.slice(dir.indexOf("cowork-harness-gate-")))).toBe(true);
    expect(cwd).not.toBe(snap);
    expect(g.tail).toBe("original\n");
    // The copy is gone afterwards.
    expect(existsSync(dir)).toBe(false);
  });

  it("a gate that writes into its cwd leaves the snapshot byte-identical", async () => {
    const g = await runGateCommand({ cmd: "echo changed > SKILL.md; touch new-file", snapshot: snap, variant: "v1", timeoutS: 30 });
    expect(g.ok).toBe(true);
    expect(readFileSync(join(snap, "SKILL.md"), "utf8")).toBe("original\n");
    expect(readdirSync(snap)).toEqual(["SKILL.md"]);
  });

  it("a non-zero exit fails, naming the code", async () => {
    const g = await runGateCommand({ cmd: "echo boom >&2; exit 3", snapshot: snap, variant: "v1", timeoutS: 30 });
    expect(g).toMatchObject({ ok: false, code: 3, timedOut: false });
    expect(g.tail).toBe("boom\n");
    expect(gateFailureText(g, 30)).toBe("the gate command exited 3; no rep of this variant ran");
  });

  it("the tail keeps the last GATE_TAIL_BYTES of output", async () => {
    const g = await runGateCommand({
      cmd: "i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done; exit 1",
      snapshot: snap,
      variant: "v1",
      timeoutS: 30,
    });
    expect(Buffer.byteLength(g.tail)).toBeLessThanOrEqual(GATE_TAIL_BYTES);
    expect(g.tail.endsWith("line-1999\n")).toBe(true);
  });

  it("a timeout kills the whole process group and fails as timed out", async () => {
    const pidFile = join(scratch, "child.pid");
    const g = await runGateCommand({ cmd: `sleep 30 & echo $! > '${pidFile}'; wait`, snapshot: snap, variant: "v1", timeoutS: 1 });
    expect(g).toMatchObject({ ok: false, timedOut: true });
    expect(gateFailureText(g, 1)).toBe("the gate command timed out after 1s; no rep of this variant ran");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 15_000);
});
