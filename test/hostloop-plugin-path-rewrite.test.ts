import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBaseline, PLUGIN_PATH_VM_REWRITE_MIN_VERSION } from "../src/baseline.js";
import { loadSession, buildLaunchPlan, type LaunchPlan } from "../src/session.js";
import { buildPluginPathRewrites, rewritePluginPaths, type PluginPathRewrite } from "../src/hostloop/plugin-path-rewrite.js";
import { hostLoopPluginPathRewrites } from "../src/runtime/hostloop.js";
import { pluginDirArgs, dockerRunArgv } from "../src/runtime/argv.js";
import { resolveHostLoopBindMounts, stageHostLoopWorkspace } from "../src/runtime/hostloop-stage.js";
import { makeWorkspaceHandler } from "../src/hostloop/workspace-handler.js";
import { scanEvents } from "../src/run/execute.js";

// Cowork's host loop runs the agent on the host, so the agent substitutes a plugin's HOST path into a skill's
// text, while the shell runs in the VM. From Desktop 1.40609.0 the host-loop bash tool rewrites a plugin's host
// path, written into the command, to the plugin's VM mount before the command runs. These tests pin the
// harness's reproduction of that rule: which spellings are keys, where a match may start and end, the order
// keys apply in, and that only the executed string changes.
//
// Every host path here is a literal string or comes from the harness's own staging code; nothing depends on
// os.tmpdir()'s shape, which differs between macOS and Linux CI.

const VM_SESSION = "/sessions/local_abc";
const latest = loadBaseline("latest");

function remotePlan(): LaunchPlan {
  const src = mkdtempSync(join(tmpdir(), "cwh-rw-src-"));
  return buildLaunchPlan(loadSession({ plugins: { remote_plugins: [src] } }), latest, mkdtempSync(join(tmpdir(), "cwh-rw-out-")));
}

// One real plan, so the plugin mount path has the harness's real `.remote-plugins/plugin_<id>` shape.
const plan = remotePlan();
const P = plan.pluginDirs[0]!;
const CFG = "/Users/u/.cowork-harness/runs/s/local_abc/claude-config";
const planAt = { ...plan, configDir: CFG };

const MNT_DEFAULT = "/Users/u/.cowork-harness/runs/s/local_abc/work/session/mnt";
const MNT_SPACE = "/var/folders/xy/T/run dir/work/session/mnt";
const MNT_TMP = "/tmp/r/work/session/mnt";

const H = `${MNT_DEFAULT}/${P}`;
const V = `${VM_SESSION}/mnt/${P}`;
const mapDefault = hostLoopPluginPathRewrites(latest, planAt, MNT_DEFAULT, VM_SESSION);

describe("the plan carries the real staged shape (precondition)", () => {
  it("a remote plugin mounts at .remote-plugins/plugin_<id>", () => {
    expect(P).toMatch(/^\.remote-plugins\/plugin_[0-9A-Za-z]{24}$/);
  });
});

describe("rewritePluginPaths: the boundary table", () => {
  const rw = (cmd: string) => rewritePluginPaths(cmd, mapDefault);
  it.each([
    ["1: right boundary `/`", `bash ${H}/scripts/build.sh`, `bash ${V}/scripts/build.sh`],
    ["2: the recorded `cd … &&` shape", `cd ${H} && node scripts/state.js`, `cd ${V} && node scripts/state.js`],
    ["3: an opening double quote after a space", `python3 "${H}/x.py"`, `python3 "${V}/x.py"`],
    ["4: an opening single quote after `=`", `X='${H}'`, `X='${V}'`],
    ["5: inside backticks", "R=`ls " + H + "`", "R=`ls " + V + "`"],
    ["6: `=` is not a left blocker", `tool --root=${H}`, `tool --root=${V}`],
    ["6b: `:` and `$` are not left blockers", `a:${H} $${H}`, `a:${V} $${V}`],
    ["6c: a key as the whole command", H, V],
  ])("%s", (_n, cmd, want) => expect(rw(cmd)).toBe(want));

  it.each([
    ["7: a closing quote right before the key", `echo "a"${H}`],
    ["8a: `-` after the key", `cat /x ${H}-v2/f`],
    ["8b: `.` after the key", `cp ${H}.bak /y`],
    ["8c: `:` after the key", `X=${H}:/y`],
    ["8d: a letter after the key", `ls ${H}x`],
    ["8e: `,` and `=` after the key", `echo ${H}, ${H}=1`],
    ["9a: the key nested in a longer path", `ls /prefix${H}`],
    ["9b: a file URL", `open file://${H}/x`],
    ["9c: a letter or digit before the key", `ls x${H} 9${H}`],
  ])("%s → unchanged", (_n, cmd) => expect(rw(cmd)).toBe(cmd));

  it("10: the literal tokens are never keys — byte-identical", () => {
    for (const cmd of ["bash ${CLAUDE_PLUGIN_ROOT}/x.sh", "bash $CLAUDE_PLUGIN_ROOT/x.sh", 'python3 "${CLAUDE_SKILL_DIR}/a.py"'])
      expect(rw(cmd)).toBe(cmd);
  });

  it("11: every occurrence is rewritten; an unrelated host path is left alone", () => {
    expect(rw(`cp ${H}/a /Users/u/other && cat ${H}/b`)).toBe(`cp ${V}/a /Users/u/other && cat ${V}/b`);
  });

  it("an empty map, or none, returns the command unchanged", () => {
    expect(rewritePluginPaths(`bash ${H}/x`, [])).toBe(`bash ${H}/x`);
    expect(rewritePluginPaths("", mapDefault)).toBe("");
  });
});

describe("the opening-quote rule", () => {
  const one: PluginPathRewrite[] = [{ hostPath: "/k", vmPath: "/sessions/s/mnt/two" }];
  it("a single quote before the key counts itself: one quote is odd, so it opens", () => {
    expect(rewritePluginPaths("cat '/k/f'", one)).toBe("cat '/sessions/s/mnt/two/f'");
    expect(rewritePluginPaths('cat "/k/f"', one)).toBe('cat "/sessions/s/mnt/two/f"');
  });
  it("an opening quote must itself follow whitespace, `=`, `;`, `|`, `&`, `(`, `<`, `{` or the start", () => {
    for (const pre of [" ", "=", ";", "|", "&", "(", "<", "{"])
      expect(rewritePluginPaths(`x${pre}"/k"`, one)).toBe(`x${pre}"/sessions/s/mnt/two"`);
    expect(rewritePluginPaths('"/k"', one)).toBe('"/sessions/s/mnt/two"');
    expect(rewritePluginPaths('x:"/k"', one)).toBe('x:"/k"');
    expect(rewritePluginPaths('ab"/k"', one)).toBe('ab"/k"');
  });
  it("the count is naive: it ignores escapes and the other quote kinds", () => {
    // An escaped `\"` still counts, so the next `"` is the second: not an opener.
    expect(rewritePluginPaths('echo \\" "/k"', one)).toBe('echo \\" "/k"');
    // A `'` does not affect the `"` count.
    expect(rewritePluginPaths(`echo ' "/k"`, one)).toBe(`echo ' "/sessions/s/mnt/two"`);
  });
  it("quotes are counted in the string an entry receives — after the longer keys were already replaced", () => {
    // The first key carries a `'`. Counted in the ORIGINAL command, the quote before `/k` is the second `'`
    // (even, so not an opener). After the first entry replaced its key, it is the only one (odd, an opener).
    const map: PluginPathRewrite[] = [
      { hostPath: "/Users/o'brien/plug", vmPath: "/sessions/s/mnt/one" },
      { hostPath: "/k", vmPath: "/sessions/s/mnt/two" },
    ];
    expect(rewritePluginPaths("cat /Users/o'brien/plug '/k/f'", map)).toBe("cat /sessions/s/mnt/one '/sessions/s/mnt/two/f'");
  });
  it("within one entry every occurrence is judged against that entry's input, not its partial output", () => {
    const map: PluginPathRewrite[] = [{ hostPath: "/o'b/p", vmPath: "/sessions/s/mnt/one" }];
    // The second occurrence follows the key's own `'` plus one more: even in the entry's input, so it stays.
    expect(rewritePluginPaths("cat /o'b/p '/o'b/p'", map)).toBe("cat /sessions/s/mnt/one '/o'b/p'");
  });
});

describe("the key spellings (Desktop's variant set, nothing more)", () => {
  const planSpace = { ...plan, configDir: "/cfg/claude-config" };
  const mapSpace = hostLoopPluginPathRewrites(latest, planSpace, MNT_SPACE, VM_SESSION);
  const HS = `${MNT_SPACE}/${P}`;
  const rw = (cmd: string) => rewritePluginPaths(cmd, mapSpace);

  it("one plugin whose staged and install paths agree yields exactly eight keys, all to its VM path", () => {
    const keys = mapSpace.filter((e) => e.vmPath === V).map((e) => e.hostPath);
    const seg = (p: string, q: string) =>
      p
        .split("/")
        .map((s) => (s.includes(" ") ? `${q}${s}${q}` : s))
        .join("/");
    const raw = HS;
    const priv = `/private${HS}`;
    expect(new Set(keys)).toEqual(
      new Set([
        raw,
        priv,
        raw.replaceAll(" ", "\\ "),
        priv.replaceAll(" ", "\\ "),
        seg(raw, '"'),
        seg(raw, "'"),
        seg(priv, '"'),
        seg(priv, "'"),
      ]),
    );
    expect(keys).toHaveLength(8);
    for (const e of mapSpace) expect(e.hostPath).not.toBe(e.vmPath);
  });

  it("12: the raw spaced path inside an opening quote", () => {
    expect(rw(`bash "${HS}/x.sh"`)).toBe(`bash "${V}/x.sh"`);
  });
  it("13: the /private twin", () => {
    expect(rw(`bash "/private${HS}/x.sh"`)).toBe(`bash "${V}/x.sh"`);
  });
  it("14: escaped spaces", () => {
    expect(rw(`bash ${HS.replaceAll(" ", "\\ ")}/x.sh`)).toBe(`bash ${V}/x.sh`);
  });
  it("15: per-segment double and single quotes", () => {
    expect(rw(`bash /var/folders/xy/T/"run dir"/work/session/mnt/${P}/x.sh`)).toBe(`bash ${V}/x.sh`);
    expect(rw(`bash /var/folders/xy/T/'run dir'/work/session/mnt/${P}/x.sh`)).toBe(`bash ${V}/x.sh`);
  });
  it("16: a whole-prefix quote is not a generated spelling, so it is not rewritten", () => {
    const cmd = `bash "/var/folders/xy/T/run dir"/work/session/mnt/${P}/x.sh`;
    expect(rw(cmd)).toBe(cmd);
  });
  it("/tmp gets no /private twin (Desktop twins only /var)", () => {
    const m = hostLoopPluginPathRewrites(latest, planAt, MNT_TMP, VM_SESSION);
    expect(m.some((e) => e.hostPath.startsWith("/private/tmp"))).toBe(false);
    const cmd = `bash /private${MNT_TMP}/${P}/x.sh`;
    expect(rewritePluginPaths(cmd, m)).toBe(cmd);
    expect(rewritePluginPaths(`bash ${MNT_TMP}/${P}/x.sh`, m)).toBe(`bash ${V}/x.sh`);
  });
  it("a backslash host spelling also keys its forward-slash form", () => {
    const m = buildPluginPathRewrites({
      vmMntRoot: "/sessions/s/mnt",
      plugins: [{ vmPath: "/sessions/s/mnt/.remote-plugins/p", stagedPath: "/Users/u/a\\b/plugin", installPath: "/Users/u/a\\b/plugin" }],
    });
    expect(m.map((e) => e.hostPath).sort()).toEqual(["/Users/u/a/b/plugin", "/Users/u/a\\b/plugin"]);
    expect(rewritePluginPaths("cat /Users/u/a/b/plugin/x", m)).toBe("cat /sessions/s/mnt/.remote-plugins/p/x");
  });
  it("distinct staged and install paths both key the same VM path; the first insertion wins across plugins", () => {
    const m = buildPluginPathRewrites({
      vmMntRoot: "/sessions/s/mnt",
      plugins: [
        { vmPath: "/sessions/s/mnt/.remote-plugins/a", stagedPath: "/tmp/alias/a", installPath: "/Users/u/inst/a" },
        { vmPath: "/sessions/s/mnt/.remote-plugins/b", stagedPath: "/tmp/alias/a", installPath: "/Users/u/inst/b" },
      ],
    });
    const get = (k: string) => m.find((e) => e.hostPath === k)?.vmPath;
    expect(get("/tmp/alias/a")).toBe("/sessions/s/mnt/.remote-plugins/a");
    expect(get("/Users/u/inst/a")).toBe("/sessions/s/mnt/.remote-plugins/a");
    expect(get("/Users/u/inst/b")).toBe("/sessions/s/mnt/.remote-plugins/b");
  });
});

describe("plugins that produce no entries", () => {
  it("a VM path with a character outside the safe set (a space in the mount name) is never a rewrite target", () => {
    const src = join(mkdtempSync(join(tmpdir(), "cwh-rw-sp-")), "my plugin");
    mkdirSync(join(src, ".claude-plugin"), { recursive: true });
    writeFileSync(join(src, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "myp" }));
    const p = buildLaunchPlan(loadSession({ plugins: { local_plugins: [src] } }), latest, mkdtempSync(join(tmpdir(), "cwh-rw-out-")));
    // precondition: the space really reaches the mount path, so this cannot pass vacuously
    expect(p.pluginDirs.some((d) => d.endsWith("/my plugin"))).toBe(true);
    const m = hostLoopPluginPathRewrites(latest, { ...p, configDir: CFG }, MNT_DEFAULT, VM_SESSION);
    expect(m.every((e) => e.vmPath === `${VM_SESSION}/mnt/.claude/skills`)).toBe(true);
    const cmd = `bash "${MNT_DEFAULT}/${p.pluginDirs[0]}/x.sh"`;
    expect(rewritePluginPaths(cmd, m)).toBe(cmd);
  });
  it("a VM path outside the mount root, or with a `..` segment, is skipped", () => {
    const mk = (vmPath: string) =>
      buildPluginPathRewrites({ vmMntRoot: "/sessions/s/mnt", plugins: [{ vmPath, stagedPath: "/h/p", installPath: "/h/p" }] });
    expect(mk("/sessions/other/mnt/p")).toEqual([]);
    expect(mk("/sessions/s/mnt/../etc")).toEqual([]);
    expect(mk("/sessions/s/mnt/a/../../x")).toEqual([]);
    expect(mk("/sessions/s/mnt/")).toEqual([]);
  });
  it("the VM tail is normalised with POSIX rules", () => {
    const m = buildPluginPathRewrites({
      vmMntRoot: "/sessions/s/mnt",
      plugins: [{ vmPath: "/sessions/s/mnt//.remote-plugins/./p", stagedPath: "/h/p", installPath: "/h/p" }],
    });
    expect(m).toEqual([{ hostPath: "/h/p", vmPath: "/sessions/s/mnt/.remote-plugins/p" }]);
  });
});

describe("ordering: longest key first", () => {
  it("a key nested inside another applies after it", () => {
    const m = buildPluginPathRewrites({
      vmMntRoot: "/sessions/s/mnt",
      plugins: [
        { vmPath: "/sessions/s/mnt/one", stagedPath: "/a/p", installPath: "/a/p" },
        { vmPath: "/sessions/s/mnt/two", stagedPath: "/a/p/sub", installPath: "/a/p/sub" },
      ],
    });
    expect(m.map((e) => e.hostPath)).toEqual(["/a/p/sub", "/a/p"]);
    expect(rewritePluginPaths("cd /a/p/sub/f && ls /a/p/g", m)).toBe("cd /sessions/s/mnt/two/f && ls /sessions/s/mnt/one/g");
  });
  it("the skills dir and a plugin rewrite in one command", () => {
    const cmd = `bash ${CFG}/skills/my-skill/run.sh && bash ${H}/x.sh`;
    expect(rewritePluginPaths(cmd, mapDefault)).toBe(`bash ${VM_SESSION}/mnt/.claude/skills/my-skill/run.sh && bash ${V}/x.sh`);
  });
});

describe("the skills mapping", () => {
  it("<configDir>/skills maps to <session>/mnt/.claude/skills", () => {
    expect(rewritePluginPaths(`bash ${CFG}/skills/my-skill/run.sh`, mapDefault)).toBe(
      `bash ${VM_SESSION}/mnt/.claude/skills/my-skill/run.sh`,
    );
  });
  it("a sibling name is not a match", () => {
    const cmd = `ls ${CFG}/skills-old/x`;
    expect(rewritePluginPaths(cmd, mapDefault)).toBe(cmd);
  });
  it("a relative configDir is resolved to an absolute path before it becomes a key", () => {
    const m = hostLoopPluginPathRewrites(latest, { ...plan, configDir: "rel/claude-config" }, MNT_DEFAULT, VM_SESSION);
    const keys = m.filter((e) => e.vmPath === `${VM_SESSION}/mnt/.claude/skills`).map((e) => e.hostPath);
    expect(keys).toContain(join(resolve("rel/claude-config"), "skills"));
    expect(keys).not.toContain("rel/claude-config/skills");
  });
});

describe("seam: every key and value is a path the harness itself produces", () => {
  it("each plugin key is the exact --plugin-dir the agent was given", () => {
    const dirs = pluginDirArgs(planAt, MNT_DEFAULT).filter((_, i) => i % 2 === 1);
    expect(dirs).toEqual([H]);
    expect(mapDefault.find((e) => e.hostPath === H)?.vmPath).toBe(V);
  });
  it("each value is a guest path the sidecar binds", () => {
    const argv = dockerRunArgv({
      network: "n",
      lockdown: false,
      sessionRoot: VM_SESSION,
      sessionHost: "/H/work/session",
      image: "img",
      env: {},
      readOnlyMountPaths: planAt.mounts.filter((mt) => mt.mode === "r" && mt.kind !== "folder").map((mt) => mt.mountPath),
      extraBinds: resolveHostLoopBindMounts(planAt, VM_SESSION),
    });
    const guests = new Set(argv.flatMap((a, i) => (argv[i - 1] === "-v" ? [a.split(":")[1]!] : [])).concat([VM_SESSION]));
    for (const e of mapDefault) {
      const bound = [...guests].some((g) => e.vmPath === g || e.vmPath.startsWith(`${g}/`));
      expect(bound, e.vmPath).toBe(true);
    }
    expect(new Set(mapDefault.map((e) => e.vmPath))).toEqual(new Set([V, `${VM_SESSION}/mnt/.claude/skills`]));
    // The skills value is the exact guest path of the skills bind, not merely under the session root.
    expect(resolveHostLoopBindMounts(planAt, VM_SESSION).some((b) => b.guestPath === `${VM_SESSION}/mnt/.claude/skills`)).toBe(true);
  });
});

describe("version gate", () => {
  it("the constant is the first Desktop that carries the rewrite", () => {
    expect(PLUGIN_PATH_VM_REWRITE_MIN_VERSION).toBe("1.40609.0");
  });
  it("a baseline before it gets no map; one at it does", () => {
    expect(hostLoopPluginPathRewrites(loadBaseline("desktop-1.37937.1"), planAt, MNT_DEFAULT, VM_SESSION)).toEqual([]);
    expect(hostLoopPluginPathRewrites(loadBaseline("desktop-1.40609.0"), planAt, MNT_DEFAULT, VM_SESSION).length).toBeGreaterThan(0);
  });
});

describe("spawnHostLoop threads the map into the workspace bash handler", () => {
  // spawnHostLoop starts real processes, so this pins the wiring at the source (the same shape as the other
  // spawnHostLoop source guards). The map is built from the SAME mntHost the agent's --plugin-dir uses and the
  // SAME sessionRoot the sidecar binds.
  const SRC = readFileSync("src/runtime/hostloop.ts", "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  it.each(["hostLoopPluginPathRewrites(baseline, plan, mntHost, sessionRoot)", "pluginPathRewrites,\n"])("%s", (anchor) =>
    expect(SRC.split(anchor).length - 1).toBe(1),
  );
  it("the handler call receives it", () => {
    const call = SRC.slice(SRC.indexOf("makeWorkspaceHandler({"));
    expect(call.slice(0, call.indexOf("});"))).toMatch(/\bpluginPathRewrites\b/);
  });
});

// ---------------------------------------------------------------------------------------------
// The handler end to end, with a fake `docker` that prints the command it was asked to run.
// ---------------------------------------------------------------------------------------------

const fakeRunner = (body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "cwh-rw-runner-"));
  const f = join(dir, "runner.sh");
  writeFileSync(f, "#!/bin/sh\n" + body);
  chmodSync(f, 0o755);
  return f;
};
// argv: exec -w <cwd> <container> <shell> -c <command>  ($1 … $7)
const PRINT_COMMAND = 'for a; do last=$a; done; printf "%s" "$last"\n';

async function callBash(opts: { runner: string; rewrites?: PluginPathRewrite[] }, args: Record<string, unknown>) {
  const h = makeWorkspaceHandler({
    containerName: "c",
    vmMnt: `${VM_SESSION}/mnt`,
    runner: opts.runner,
    ...(opts.rewrites ? { pluginPathRewrites: opts.rewrites } : {}),
  });
  const out = (await h("workspace", { method: "tools/call", params: { name: "bash", arguments: args } })) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  return out.result;
}

describe("the workspace bash handler runs the rewritten command", () => {
  it("a host plugin path in the command reaches the shell as the VM path", async () => {
    const r = await callBash({ runner: fakeRunner(PRINT_COMMAND), rewrites: mapDefault }, { command: `bash ${H}/scripts/x.sh` });
    expect(r.content[0]!.text).toBe(`bash ${V}/scripts/x.sh`);
  });
  it("with no map (the default) the command passes through byte-identical", async () => {
    const r = await callBash({ runner: fakeRunner(PRINT_COMMAND) }, { command: `bash ${H}/scripts/x.sh` });
    expect(r.content[0]!.text).toBe(`bash ${H}/scripts/x.sh`);
  });
  it("the tool input it was handed is not mutated (the recorded input keeps the host path)", async () => {
    const args = { command: `cd ${H} && ls` };
    await callBash({ runner: fakeRunner(PRINT_COMMAND), rewrites: mapDefault }, args);
    expect(args.command).toBe(`cd ${H} && ls`);
  });
  it("output naming the VM path reaches the model as is — nothing maps it back to the host path", async () => {
    const runner = fakeRunner(`printf "%s" "${V}/out.txt"\n`);
    const r = await callBash({ runner, rewrites: mapDefault }, { command: `ls ${H}` });
    expect(r.content[0]!.text).toBe(`${V}/out.txt`);
  });
  it("the shell is bash, as in Cowork", async () => {
    const r = await callBash({ runner: fakeRunner('printf "%s" "$5"\n') }, { command: "true" });
    expect(r.content[0]!.text).toBe("bash");
  });
  it("a bash-only construct runs (process substitution, which a POSIX sh rejects)", async () => {
    // The fake runner drops `exec -w <cwd> <container>` and runs the rest on the host.
    const r = await callBash({ runner: fakeRunner('shift 4; exec "$@"\n') }, { command: "cat <(printf ok)" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text).toBe("ok");
  });
});

describe("the post-run scan reads the recorded command, not the executed one", () => {
  const events = (cmd: string) => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-rw-ev-"));
    const f = join(dir, "events.jsonl");
    writeFileSync(
      f,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "mcp__workspace__bash", input: { command: cmd } }] },
      }) + "\n",
    );
    return f;
  };
  it("a host plugin path command leaves self_heal_ran false", () => {
    expect(scanEvents(events(`bash ${H}/x.sh`)).selfHealRan).toBe(false);
  });
  it("a model-written VM plugin path counts, for a local and for a remote plugin", () => {
    expect(scanEvents(events(`bash ${VM_SESSION}/mnt/.local-plugins/marketplaces/m/p/x.sh`)).selfHealRan).toBe(true);
    expect(scanEvents(events(`bash ${V}/x.sh`)).selfHealRan).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The direct-exec form: a plugin script run as "<root>/scripts/x.sh" (no `bash` in front) needs its exec
// bit to survive staging. Cowork runs it from the VM mount; so must the harness, from the staged copy the
// sidecar binds.
// ---------------------------------------------------------------------------------------------
describe("a plugin script staged for hostloop keeps its exec bit", () => {
  function stagedPlugin() {
    const src = mkdtempSync(join(tmpdir(), "cwh-rw-exec-src-"));
    mkdirSync(join(src, "scripts"));
    writeFileSync(join(src, "scripts", "x.sh"), '#!/bin/sh\necho ran-from "$0"\n');
    chmodSync(join(src, "scripts", "x.sh"), 0o755);
    writeFileSync(join(src, "scripts", "data.txt"), "d\n");
    chmodSync(join(src, "scripts", "data.txt"), 0o640);
    const out = mkdtempSync(join(tmpdir(), "cwh-rw-exec-out-"));
    const p = buildLaunchPlan(loadSession({ plugins: { remote_plugins: [src] } }), latest, out);
    const mntHost = join(out, "work", "session", "mnt");
    mkdirSync(mntHost, { recursive: true });
    stageHostLoopWorkspace(p, mntHost);
    return { p, mntHost, staged: join(mntHost, p.pluginDirs[0]!) };
  }

  it("the staged copy keeps 0755 on the script and does not widen a 0640 file", () => {
    const { staged } = stagedPlugin();
    expect(statSync(join(staged, "scripts", "x.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(staged, "scripts", "data.txt")).mode & 0o777).toBe(0o640);
  });

  it("end to end: the rewritten VM path executes the staged script directly", async () => {
    const { p, mntHost, staged } = stagedPlugin();
    const map = hostLoopPluginPathRewrites(latest, p, mntHost, VM_SESSION);
    // The fake runner stands in for the sidecar's bind mount: it maps <session>/mnt back to the staged tree,
    // then runs the shell it was handed.
    const runner = fakeRunner(
      `shift 4; sh_=$1; flag=$2; cmd=$(printf '%s' "$3" | sed "s#${VM_SESSION}/mnt#${mntHost}#g"); exec "$sh_" "$flag" "$cmd"\n`,
    );
    const r = await callBash({ runner, rewrites: map }, { command: `"${staged}/scripts/x.sh"` });
    expect(r.isError).toBeFalsy();
    expect(r.content[0]!.text.trim()).toBe(`ran-from ${staged}/scripts/x.sh`);
  });
});
