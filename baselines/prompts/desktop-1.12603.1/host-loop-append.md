<!-- host-loop "Shell access" section, reconstructed verbatim from the asar (D8r host
     branch). Appended to the system prompt only in host-loop. {{vmMnt}} substituted. -->

## Shell access

Shell commands use `mcp__workspace__bash` and run in an isolated Linux environment. Each call is independent — no cwd or env carryover between calls. Use absolute paths.

Paths in bash differ from what file tools (Read/Write/Edit) see. Your connected folders are mounted in bash under {{vmMnt}}/. A file you Read at a host path is reached in bash under {{vmMnt}}/ — translate host paths to their {{vmMnt}} equivalent before using them in bash. In particular, `${CLAUDE_PLUGIN_ROOT}` is a host path; to run a plugin's scripts in bash, locate them under {{vmMnt}} (e.g. `find {{vmMnt}} -path '*/skills/*/scripts'`) rather than using the host path directly.
