# Cloud-lane probe kit (maintainers)

Tooling for recording what a **real cloud task** in Claude Desktop does with its tools: the tool names it
calls, their input field names, the shape of each result, and the permission mode. It records shapes, never
content. The harness uses the result to check its model of the cloud lane's device bridge
(`mcp__remote-devices__*`) against production. This is not a feature of the harness and is not shipped in the
npm package.

## What is in the kit

| File                                   | What it does |
| -------------------------------------- | ------------ |
| `plugin/`                              | A throwaway plugin, `cwh-cloud-probe`. `hooks/hooks.json` runs `hooks/capture.py` on every `PreToolUse` and `PostToolUse` (matcher `.*`). |
| `plugin/hooks/capture.py`              | Appends one JSON line per tool call to `/root/cwh-cloud-probe/capture.jsonl` inside the cloud task's container. Redacted when written: see "What is recorded". |
| `verify.py`                            | Run on the folder you download into. It checks that the folder holds only the two export files, integrity (the sha256 and line count the task printed), redaction (every line), and answerability (the capture can answer its probe). |

The rules are tested in `test/cloud-probe-kit.test.ts`. Synthetic payloads carrying session ids, home paths,
emails, fictional connector names (one that looks like a builtin), a device name, folder-named keys, an input keyed
by client names and a command are fed through the real hook. The test asserts that none of them reaches the
capture, and that the verifier rejects a wrong checksum, a tampered line, a download folder holding anything else
(the salt above all) and a capture that cannot answer its probe.

### What is recorded

- **Kept verbatim** (product vocabulary, from explicit allowlists):
  - the builtin tool names, the remote-devices tool names (`mcp__` or `internal__` spellings, plus the
    computer-use and browser groups) and the known cowork tools;
  - the input field **names** of those tools only, when they are plain identifiers (any other key, a path or a
    file name, is fingerprinted). This is a residual by design: a vocabulary tool's field names are the product's,
    so they are kept to compare the harness's model of the tool with production;
  - `timeout_ms`;
  - the permission mode;
  - a shell result's exit code and error flag;
  - the working directory only when it is `/home/claude`, `/root` or `/tmp`.
- **Fingerprinted** (12 hex characters of an HMAC under a random salt): every other tool, server and connector
  name (a bare `CamelCase` name included), every other tool's input field names (a connector's schema keys can
  name its category, and a private tool's input can be keyed by client names), response keys outside a fixed
  schema list, and result text. At most 40 input keys are written per call, plus the count when there were more.
- **Bucketed:** every string length (and the result text length) is written as the next power of two at or above
  it, so a length cannot identify a device name or a home directory.
- **Never recorded:** commands, paths, ids, emails, timestamps, file names or contents, the device name, folder
  names, and any tool's input field names other than the vocabulary tools' (those are fingerprinted).
- **The salt:** it stays in the container in `/root/cwh-cloud-probe/.salt`, is never exported, and the export
  step shreds it. Fingerprints are comparable only within one capture. One container keeps one salt across the
  tasks it serves, and the capture file keeps their lines too, so an export can carry earlier tasks' lines: the
  verifier and the summary cover them all.
- **Errors:** a failure inside the hook writes a `<hook-error>` line carrying only the exception's class name.
- **Inert elsewhere:** the hook writes nothing unless the task is a Claude Desktop cloud task
  (`CLAUDE_CODE_REMOTE=true` and `CLAUDE_CODE_ENTRYPOINT=remote_cowork`). That covers the plugin's account sync:
  local Claude Code sessions and other cloud sessions load it but record nothing.

## The sitting: P0 + P6 (about 60 minutes, 4 tasks)

Use one Claude Desktop organisation throughout, one whose tasks run in the cloud: plugin installs are per
organisation.

**Privacy rules for every sitting** (the kit hooks every tool call of a real task):
- a **synthetic folder only** (a throwaway folder with planted files), connected alone; never a real project;
- turn **off** every connector for the probe tasks where the composer allows it;
- **uninstall the plugin immediately after the last export** of the sitting (section 5), before any other task;
- the downloaded files and the verifier's summary **never enter any repository** (the summary prints tool names
  verbatim): only paraphrased facts are written up. `.gitignore` covers `export.jsonl`, `export.sha256` and
  `cwh-cloud-probe*`.

### 1. Prepare (about 5 minutes)

1. Create a throwaway folder with two small text files, for example `~/cwh-probe-folder/a.txt` and `b.txt`.
   Never use a real project folder. Create an empty download folder for each task's export, for example
   `~/cwh-probe-dl/p0`.
2. Zip the plugin: `cd probes/cloud/plugin && zip -r ../cwh-cloud-probe.zip . && cd -`.
3. In Claude Desktop, go to Customize > Plugins > Add > Upload plugin, and choose `probes/cloud/cwh-cloud-probe.zip`.
4. **Optional:** stop the plugin loading in your local Claude Code sessions for the install window. A synced
   plugin's hooks load in terminal sessions too: they record nothing there, but cost about a third of a second per
   tool call. To disable it locally, first check its exact id with `/plugin` in Claude Code (expected
   `cwh-cloud-probe@synced`). Then add this to `~/.claude/settings.json` (merge it into an existing
   `enabledPlugins` block if you have one), and remove it after the sitting:

   ```json
   { "enabledPlugins": { "cwh-cloud-probe@synced": false } }
   ```

### 2. P0: device-bridge census (one task, about 10 minutes)

1. Start a **new task** with **only** `~/cwh-probe-folder` connected.
2. Paste:

   > Use your tools for my computer, one at a time: first get device info; then list the connected folder;
   > then run this with the shell on my computer: `pwd; id -u; uname -m; ls $HOME/mnt`; then run
   > `ls $HOME/mnt/does-not-exist` with the same tool. Tell me only which tools you used and whether each call
   > succeeded — do not show me file names.

3. Approve any card Desktop shows and note which cards appeared.
4. Run the **export step** (section 4) in the same task, with `--probe p0`.

### 3. P6: permission surface (three tasks, about 10 minutes each)

The composer's approval setting has three choices: **Manual** (the default), **Auto** and **Skip**. Do one task
for each. If your build shows a different set, do one task per choice shown and note the names.

1. Start a **new task** with **only** `~/cwh-probe-folder` connected, and set the approval choice first.
2. Paste:

   > Using the shell on my computer, create `probe-note.txt` containing the word hello in the connected folder,
   > then delete that file with rm. Tell me whether each step worked.

3. Write down: the approval choice; every card or dialog that appeared (folder access, delete permission, a tool
   approval); what you clicked; whether the delete worked.
   - **Prediction to check:** Anthropic's help centre says Claude always asks before permanently deleting files,
     in any mode. Record whether a delete prompt appeared in each of the three tasks.
4. Run the **export step** (section 4) in the same task, with `--probe p6`.

### 4. Export step (end of every probe task, about 3 minutes)

Paste:

> Using **your own Bash tool** (not the shell on my computer), run exactly:
> `cp /root/cwh-cloud-probe/capture.jsonl /home/claude/export.jsonl && { shred -u /root/cwh-cloud-probe/.salt 2>/dev/null || rm -f /root/cwh-cloud-probe/.salt; } && wc -l /home/claude/export.jsonl && sha256sum /home/claude/export.jsonl | tee /home/claude/export.sha256`
> Print both output lines exactly as they appear. Then send me exactly two files, `/home/claude/export.jsonl`
> and `/home/claude/export.sha256`, and no other file.

Why this shape:
- **The copy:** the hook keeps appending to `capture.jsonl` during the checksum and the send, so only a frozen
  copy can match its checksum.
- **The agent's own shell:** the capture lives in the cloud container, which the shell on your computer cannot
  see.
- **`/home/claude`:** it is the delivery location that has been measured.
- **Remove the salt** (`shred -u`, or `rm -f` where `shred` is missing): after the copy no later step can ship it,
  so a loose follow-up prompt cannot make every fingerprint dictionary-attackable. (The hook makes a new salt for
  any later tool call; it is never exported either.)
- **Output without both lines** (the `wc -l` count and the sha256) **is void**: a step of the chain failed. Run
  the export again in the same task; never send files from a run that did not print both.
- **Exactly two files:** if the task sends anything else (above all a `.salt`), the export is void: delete it
  and every downloaded file.

Download the two files into that task's empty folder (rename them to `export.jsonl` and `export.sha256` if
Desktop adds a suffix), then run, with the `wc -l` number from the transcript:

```bash
python3 probes/cloud/verify.py --probe p0 ~/cwh-probe-dl/p0 <lines>
```

Use `--probe p6` for the P6 tasks. If the hash file did not arrive, write the hash from the transcript into
`export.sha256` in that folder; any form containing the 64 hex characters works.

| Exit | Meaning |
| ---- | ------- |
| 0    | ok, prints a summary to keep |
| 1    | the checksum or line count differs from the transcript: void |
| 2    | a line failed redaction, the folder holds anything but the two export files (a Finder `.DS_Store` is ignored), a symlink, or `export.sha256` is not one line with one sha256: void, delete the folder |
| 3    | usage: the folder lacks one of the two files |
| 4    | the capture cannot answer the probe (no device-tool result for P0, no recognised permission mode for P6): void |

### 5. After the sitting (about 5 minutes)

1. **Uninstall `cwh-cloud-probe` in Customize > Plugins immediately after the last export**, before starting any
   other task. This is not optional: the plugin is synced to the account and hooks every tool call of every task.
2. If you did step 1.4, remove the `enabledPlugins` entry.
3. Write up only paraphrased facts. Never commit the downloaded files or the verifier's summary.
4. Delete `~/cwh-probe-folder`, `~/cwh-probe-dl`, and the zip once the facts are recorded.
5. The capture inside the cloud container goes away with the task's container.

## What each probe decides

- **P0:** whether the served tool names, input field names and result shapes for `get_device_info`,
  `device_list_dir` and `device_bash` match the harness's model field for field, plus the shapes of a failing
  shell command.
- **P6:** whether the approval choice reaches the agent as its permission mode, and which approvals the user still
  sees in each mode, including the delete prompt.
- **Repeat:** each probe needs a second sample before its facts are relied on. Use a second account if one is
  available; otherwise use a second day.
