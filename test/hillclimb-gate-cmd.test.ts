// `hillclimb run --gate-cmd`: the real spawn — a throwaway copy, the two variables, the timeout's group kill, the tail cap.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("an in-plugin relative symlink stays relative in the copy: a write through it never reaches the snapshot", async () => {
    mkdirSync(join(snap, "docs"));
    writeFileSync(join(snap, "docs", "ref.md"), "reference\n");
    mkdirSync(join(snap, "skills", "x"), { recursive: true });
    symlinkSync("../../docs/ref.md", join(snap, "skills", "x", "ref"));
    const seen = join(scratch, "link.txt");
    const g = await runGateCommand({
      cmd: `readlink skills/x/ref > '${seen}'; printf TAMPERED > skills/x/ref`,
      snapshot: snap,
      variant: "v1",
      timeoutS: 30,
    });
    expect(g.ok).toBe(true);
    expect(readFileSync(seen, "utf8").trim()).toBe("../../docs/ref.md");
    expect(readFileSync(join(snap, "docs", "ref.md"), "utf8")).toBe("reference\n");
    expect(readlinkSync(join(snap, "skills", "x", "ref"))).toBe("../../docs/ref.md");
  });

  it("a copy the gate made unremovable does not lose the gate's result", async () => {
    const where = join(scratch, "dir.txt");
    const g = await runGateCommand({
      cmd: `printf '%s' "$COWORK_HARNESS_VARIANT_DIR" > '${where}'; mkdir ro && touch ro/f && chmod 555 ro; exit 4`,
      snapshot: snap,
      variant: "v1",
      timeoutS: 30,
    });
    expect(g).toMatchObject({ ok: false, code: 4 });
    const ro = join(readFileSync(where, "utf8"), "ro");
    if (existsSync(ro)) {
      chmodSync(ro, 0o755);
      rmSync(join(ro, "..", ".."), { recursive: true, force: true });
    }
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

  it("a shell that exits while an escaped descendant holds the output open fails at the timeout instead of hanging", async () => {
    const pidFile = join(scratch, "escaped-after-exit.pid");
    const t0 = Date.now();
    const g = await runGateCommand({
      cmd: `python3 -c 'import os,time; os.setsid(); open("${pidFile}","w").write(str(os.getpid())); time.sleep(30)' & sleep 0.3; exit 0`,
      snapshot: snap,
      variant: "v1",
      timeoutS: 1,
    });
    try {
      process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
    } catch {
      /* already gone */
    }
    expect(g).toMatchObject({ ok: false, timedOut: true, code: 0 });
    expect(gateFailureText(g, 1)).toBe(
      "the gate exited 0, but a background process kept its output open until --gate-timeout (1s); no rep of this variant ran",
    );
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("any exit code the shell reached by itself is named, not called a timeout; a killed shell is a timeout", () => {
    const g = { ok: false, code: 3, signal: null, timedOut: true, tail: "", wallS: 1 };
    expect(gateFailureText(g, 7)).toBe(
      "the gate exited 3, but a background process kept its output open until --gate-timeout (7s); no rep of this variant ran",
    );
    expect(gateFailureText({ ...g, code: null, signal: "SIGKILL" }, 7)).toBe(
      "the gate command timed out after 7s; no rep of this variant ran",
    );
  });

  it("a descendant that left the process group and holds the output open cannot hang the pass past the timeout", async () => {
    const pidFile = join(scratch, "escaped.pid");
    const t0 = Date.now();
    const g = await runGateCommand({
      cmd: `python3 -c 'import os,time; os.setsid(); open("${pidFile}","w").write(str(os.getpid())); time.sleep(30)' & sleep 30`,
      snapshot: snap,
      variant: "v1",
      timeoutS: 1,
    });
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    expect(g).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 20_000);
});
