#!/usr/bin/env bash
# Runs tests on Linux, in node:22 as a non-root user with an empty HOME, for the path and engine-floor bugs a Mac cannot
# show. It needs Docker. By default it runs the tests changed since --base (default origin/main) plus every test that
# spawns the built CLI; --all runs the unit lane. This is a vitest subset of CI's Node 22 floor job: it runs on the host's
# architecture, with no typecheck and without COWORK_HARNESS_CONTRACT_FETCH=required.
#
#   npm run test:linux [-- --all] [-- --base <ref>]
set -euo pipefail

die() {
  echo "test:linux: $*" >&2
  exit 1
}

IMAGE="node:22"
VOLUME="cowork-harness-test-linux-npm"
base="origin/main"
all=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --all) all=1 ;;
    --base)
      [ "$#" -ge 2 ] || die "--base needs a value"
      base=$2
      shift
      ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"
docker info >/dev/null 2>&1 || die "Docker is not running"

lane=$(mktemp -d)
trap 'rm -rf "$lane"' EXIT

target=--all
if [ "$all" -eq 0 ]; then
  changed=$(npx --no-install vitest list --changed "$base" --filesOnly) || die "vitest list failed"
  {
    printf '%s\n' "$changed" | grep -E '^test/.*\.test\.ts$' || true
    git grep --untracked -l -F 'dist/cli.js' -- 'test/*.test.ts' || true
    git grep --untracked -l -E 'helpers/(hermetic-cli|stub-agent)' -- 'test/*.test.ts' || true
  } | grep -v '^test/live-' | sort -u >"$lane/list" || true
  # Counted here because `vitest list` exits 0 when it lists nothing.
  [ -s "$lane/list" ] || die "the test list is empty"
  target=/lane/list
fi

# The copy holds tracked and untracked files as they stand, minus deletions, so a new test that is not yet added still runs.
while IFS= read -r -d '' f; do
  if [ -e "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
done < <(git ls-files -z --cached --others --exclude-standard) >"$lane/paths"

docker volume create "$VOLUME" >/dev/null
docker run --rm -u root -v "$VOLUME:/cache" "$IMAGE" chown -R node:node /cache

COPYFILE_DISABLE=1 tar -cf - --null -T "$lane/paths" |
  docker run -i --rm -u node -v "$VOLUME:/cache" -v "$lane:/lane:ro" "$IMAGE" bash -c \
    'set -eu; mkdir -p /tmp/w; cd /tmp/w; tar -xf -; exec bash scripts/ci/test-linux-inner.sh "$1"' lane "$target"
