# The harness's runner for a Python command metric. It ships with cowork-harness; it is never the author's code.
#
#   python3 -S -s -B metric-runner.py <tmp> <script-rel> <events-file> [args...]
#
# <tmp> is the invocation's fresh temp dir: <tmp>/stage holds the hashed, declared files at their root-relative
# paths, and the events file sits beside it. The runner points sys.path[0] at the staged script's directory (so a
# plain `import sibling` of a declared dep works), installs a PEP 578 audit hook, and executes the staged script as
# __main__.
#
# The hook is a TRIPWIRE against accidental escape, not a sandbox (PEP 578 says so): it refuses reads outside the temp
# dir and the standard library, writes and other filesystem changes (remove, rename, link, symlink, truncate, mkdir,
# rmdir, chmod, chown, utime) outside the temp dir, directory listings outside both, name resolution, process creation, native
# loading and sockets. A determined script can defeat it; the boundary is the operator's consent to run the repo.
#
# Python 3.9 compatible: no match statements, no runtime `X | Y` types, no parenthesised context managers.
import os
import sys
import sysconfig

PREFIX = "metric sandbox: "


# Bound once, before any script code runs, so a script that reassigns os.path.realpath does not change what the hook
# sees. Still a tripwire: posixpath's own helpers can be patched too.
_REALPATH = os.path.realpath
_FSDECODE = os.fsdecode


def _real(p):
    return _REALPATH(_FSDECODE(p))


def main():
    if len(sys.argv) < 4:
        sys.stderr.write(PREFIX + "usage: metric-runner.py <tmp> <script-rel> <events> [args...]\n")
        return 2
    tmp = _real(sys.argv[1])
    stage = os.path.join(tmp, "stage")
    script = os.path.join(stage, sys.argv[2])
    events = _real(sys.argv[3])
    stdlib = sorted({_real(sysconfig.get_paths()[k]) for k in ("stdlib", "platstdlib")})
    read_roots = [tmp, events] + stdlib
    write_roots = [tmp]
    list_roots = [tmp] + stdlib

    def under(p, roots):
        try:
            rp = _real(p)
        except Exception:
            return False
        return any(rp == r or rp.startswith(r + os.sep) for r in roots)

    blocked = {
        "ctypes.dlopen",
        "subprocess.Popen",
        "os.system",
        "os.exec",
        "os.spawn",
        "os.posix_spawn",
        "os.fork",
        "os.forkpty",
        "socket.connect",
        "socket.sendto",
        "socket.sendmsg",
        "socket.bind",
        # Name resolution is a channel out too (a lookup of <data>.attacker.example).
        "socket.getaddrinfo",
        "socket.gethostbyname",
        "socket.gethostbyaddr",
        "socket.getnameinfo",
    }
    # Filesystem operations other than open: each path operand (source and destination alike) must be inside the temp
    # dir, or a script could delete, truncate or move a file outside it — or link one in and then read it.
    path_ops = {
        "os.remove": (0,),
        "os.rmdir": (0,),
        "os.mkdir": (0,),
        "os.truncate": (0,),
        "os.chmod": (0,),
        "os.chown": (0,),
        "os.utime": (0,),
        "os.rename": (0, 1),
        "os.link": (0, 1),
        "os.symlink": (0, 1),
    }
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | getattr(os, "O_APPEND", 0) | getattr(os, "O_TRUNC", 0)

    def hook(event, args):
        if event in blocked:
            raise PermissionError(PREFIX + event)
        if event in path_ops:
            for i in path_ops[event]:
                operand = args[i] if i < len(args) else None
                if operand is None or isinstance(operand, int):
                    continue
                if not under(operand, write_roots):
                    raise PermissionError(PREFIX + "%s outside the temp dir: %r" % (event, operand))
            return
        if event == "open":
            path, mode, flags = (list(args) + [None, None, None])[:3]
            if path is None or isinstance(path, int):
                return
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & write_flags)
            if writing and not under(path, write_roots):
                raise PermissionError(PREFIX + "write outside the temp dir: %r" % (path,))
            if not under(path, read_roots):
                raise PermissionError(PREFIX + "read outside the stage: %r" % (path,))
        elif event in ("os.listdir", "os.scandir"):
            path = args[0] if args else None
            if path is None or isinstance(path, int):
                path = "."
            # The import system lists the standard library's directories to find modules, so those stay listable.
            if not under(path, list_roots):
                raise PermissionError(PREFIX + "%s outside the temp dir and the standard library: %r" % (event, path))

    with open(script, "rb") as f:
        source = f.read()
    code = compile(source, script, "exec")
    sys.path[0] = os.path.dirname(script)
    sys.argv = [script] + sys.argv[3:]
    sys.addaudithook(hook)
    exec(code, {"__name__": "__main__", "__file__": script, "__builtins__": __builtins__})
    return 0


if __name__ == "__main__":
    sys.exit(main())
