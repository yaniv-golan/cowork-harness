#!/usr/bin/env bash
# CI hang evidence, job level. Usage: hang-dump.sh <delay-seconds> <out-dir>
#
# Armed in the background just before a long test step, with a delay that ends a couple of minutes before that
# step's own time limit. If the step is still running then, it is almost certainly hung: this records the state of
# every node/npm/vitest process on the runner into <out-dir>/job-<utc>/, for the always-run artifact upload after the
# step. It never kills anything; the step's time limit does that. A step that finishes first leaves nothing behind,
# because the job ends and the runner reaps this process with it.
#
# The test suite's own watchdog (test/setup/sync-child-watchdog.ts) covers a test fork blocked on a synchronous
# child. This covers what it cannot see: the vitest main process, a fork that is idle or stuck in its own exit, and
# orphaned descendants that are no longer under a fork.
#
# Linux only (reads /proc). Each command is bounded, so a wedged target cannot stall the dump. HANG_DUMP_NO_GDB=1
# skips the gdb attach, which pauses its target; the script's own test sets it, since it runs beside the live suite.
set -u
delay=$1
base=$2
sleep "$delay"

out="$base/job-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
b() { timeout --kill-after=5 "$@"; }

{
  echo "uptime: $(uptime)"
  echo "kernel.yama.ptrace_scope: $(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo '?')"
  echo "gdb: $(command -v gdb || echo 'not installed')"
} >"$out/host.txt" 2>&1
b 10 ps -eo pid,ppid,etime,pcpu,stat,wchan:32,args --forest >"$out/ps-forest.txt" 2>&1
b 10 ps -ef --forest >"$out/ps-ef-forest.txt" 2>&1

# Every process whose command line names node, npm or vitest, except this script's own pipeline.
pids=$(ps -eo pid=,args= | awk -v self=$$ '$1 != self && /node|npm|vitest/ && !/hang-dump\.sh/ {print $1}')
for pid in $pids; do
  [ -d "/proc/$pid" ] || continue
  f="$out/pid-$pid.txt"
  {
    echo "=== cmdline"; tr '\0' ' ' <"/proc/$pid/cmdline"; echo
    for x in status wchan syscall; do echo "=== $x"; cat "/proc/$pid/$x" 2>&1; echo; done
    echo "=== stack (kernel)"; b 5 sudo -n cat "/proc/$pid/stack" 2>&1
    echo "=== tasks (tid comm wchan state)"
    for t in /proc/"$pid"/task/*; do
      tid=${t##*/}
      echo "$tid $(cat "$t/comm" 2>/dev/null) $(cat "$t/wchan" 2>/dev/null) $(awk '{print $3}' "$t/stat" 2>/dev/null)"
    done
    echo "=== fds"; b 5 sudo -n ls -l "/proc/$pid/fd" 2>&1
    echo "=== gdb: thread apply all bt"
    if [ -n "${HANG_DUMP_NO_GDB:-}" ]; then
      echo "(skipped: HANG_DUMP_NO_GDB is set)"
    elif command -v gdb >/dev/null; then
      b 30 sudo -n gdb -batch -p "$pid" -ex "thread apply all bt" 2>&1
    else
      echo "(gdb not installed)"
    fi
  } >"$f" 2>&1
done
echo "dumped $(echo "$pids" | wc -w) processes to $out"
