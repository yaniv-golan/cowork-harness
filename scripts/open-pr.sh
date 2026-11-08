#!/usr/bin/env bash
# Opens a pull request after checking everything it publishes. The commits are public from the push, so the check runs
# first, over the range as well as the title, body and branch name.
#
#   scripts/open-pr.sh <body-file> [--draft] [--title T] [--base B]
#
# The title defaults to the commit subject when the branch holds exactly one commit. For maintainers: it needs the private
# pattern file. An external contributor opens a pull request the ordinary way, and CI runs the public patterns on it.
set -euo pipefail

die() {
  echo "open-pr: $*" >&2
  exit 1
}

here=$(cd "$(dirname "$0")" && pwd)
body=""
title=""
base="main"
draft=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --draft) draft=1 ;;
    --title)
      [ "$#" -ge 2 ] && [ "${2#--}" = "$2" ] || die "--title needs a value"
      title=$2
      shift
      ;;
    --base)
      [ "$#" -ge 2 ] && [ "${2#--}" = "$2" ] || die "--base needs a value"
      base=$2
      shift
      ;;
    --fill | --web) die "$1 skips the check of the title and body; pass a body file" ;;
    -*) die "unknown option: $1" ;;
    *)
      [ -z "$body" ] || die "only one body file"
      body=$1
      ;;
  esac
  shift
done
[ -n "$body" ] || die "usage: open-pr.sh <body-file> [--draft] [--title T] [--base B]"
[ -f "$body" ] || die "no such body file: $body"

branch=$(git symbolic-ref --quiet --short HEAD) || die "HEAD is detached; check out a feature branch"
[ "$branch" != "main" ] || die "refusing to open a pull request from main"
[ "$branch" != "$base" ] || die "the branch and its base are the same: $base"

git fetch --quiet origin "$base"
commits=$(git rev-list --count "origin/$base..HEAD")
[ "$commits" -gt 0 ] || die "no commits on this branch beyond origin/$base"
if [ -z "$title" ]; then
  [ "$commits" -eq 1 ] || die "$commits commits on this branch; pass --title"
  title=$(git log -1 --format=%s)
fi

title_file=$(mktemp)
trap 'rm -f "$title_file"' EXIT
printf '%s\n' "$title" >"$title_file"

npx --no-install tsx "$here/check-public-hygiene.ts" --stage create --require-private \
  --base "origin/$base" --head HEAD --body-file "$body" --title-file "$title_file" --branch "$branch"

git push -u origin HEAD
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] || die "HEAD and its upstream differ after the push"

args=(--base "$base" --head "$branch" --title "$title" --body-file "$body")
if [ "$draft" -eq 1 ]; then
  args+=(--draft)
fi
gh pr create "${args[@]}"
