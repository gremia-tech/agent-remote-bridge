#!/usr/bin/env bash
# Version and release notes for one component of this monorepo.
#   component-release.sh version SERIES PATH...   -> SERIES.N, N = commits touching PATH
#   component-release.sh notes TAG_PREFIX PATH...  -> markdown list of changes since the last tag
# N only grows, so it doubles as Android's versionCode. A repository split without history sets
# COUNT_OFFSET to the last N so versions keep increasing.
set -euo pipefail
mode=$1 arg=$2; shift 2
case $mode in
  version) echo "$arg.$(( ${COUNT_OFFSET:-0} + $(git rev-list --count HEAD -- "$@") ))" ;;
  notes)
    previous=$(git tag --list "$arg*" --sort=-v:refname | head -1)
    range=${previous:+$previous..}HEAD
    git log --no-merges --format='- %s (%h)' "$range" -- "$@" ;;
  *) echo "usage: $0 version|notes ..." >&2; exit 2 ;;
esac
