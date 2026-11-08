#!/usr/bin/env bash
# The container half of `npm run test:linux`, run from a throwaway copy of the tree. The argument is a file naming the
# tests, one per line, or --all for the unit lane.
set -euo pipefail

die() {
  echo "test:linux: $*" >&2
  exit 1
}

last=$SECONDS
phase() {
  echo "test:linux phase $1: $((SECONDS - last)) s"
  last=$SECONDS
}

[ "$#" -eq 1 ] || die "usage: test-linux-inner.sh <list-file>|--all"
[ "$(id -u)" != "0" ] || die "refusing to run as root: root hides permission bugs, and the lane exists to find them"

# The one test the image cannot run: it executes a workflow step that needs jq. CI's ubuntu job runs it.
NEEDS_JQ=test/publish-plan.test.ts
echo "test:linux skipping $NEEDS_JQ: it needs jq, which node:22 lacks; CI's ubuntu job runs it"

files=()
if [ "$1" != "--all" ]; then
  [ -f "$1" ] || die "no such list file: $1"
  missing=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ "$f" != "$NEEDS_JQ" ] || continue
    # vitest silently drops a named file that matches nothing when another name matches, so this must be checked here.
    if [ -f "$f" ]; then
      files+=("$f")
    else
      echo "test:linux: listed but not in the copy: $f" >&2
      missing=1
    fi
  done <"$1"
  [ "$missing" -eq 0 ] || exit 1
  [ "${#files[@]}" -gt 0 ] || die "the test list is empty"
  echo "test:linux files: ${#files[@]}"
else
  echo "test:linux files: all"
fi

git init -q
git add -A
git -c user.name=test-linux -c user.email=test-linux@localhost commit -q -m tree
phase copy

npm ci --cache "${TEST_LINUX_NPM_CACHE:-/cache/npm}" --prefer-offline --no-audit --no-fund
phase npm-ci

npm run -s build
[ -f dist/cli.js ] || die "dist/cli.js is missing after the build"
phase build

# Under the real home, not /tmp: the suite treats a /tmp path as a temp file, not a home directory, so a HOME there fails
# its redaction tests on any machine.
empty_home=$(mktemp -d "${HOME:?}/test-linux-home.XXXXXX")
status=0
HOME="$empty_home" npx --no-install vitest run --exclude "$NEEDS_JQ" ${files[@]+"${files[@]}"} || status=$?
phase vitest
exit "$status"
