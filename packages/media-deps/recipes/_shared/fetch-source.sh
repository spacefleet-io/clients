#!/bin/sh
# fetch-source.sh [--submodules] <id> <git-url> <commit-sha> <dest-dir>
# Fetches ONE pinned commit of one of our forks (src/sources.ts: `sha` = tip of the fork's sf/<version>),
# REFUSES it unless the fetched commit is exactly <commit-sha> (a git commit id covers the whole tree, so this is
# the integrity check), and leaves the plain tree (no .git) in <dest-dir>. Shared by every OS recipe.
#
# This is the ONLY way a recipe obtains library source: no tarball downloads, no upstream urls. With
# --submodules the checkout also initialises the submodules the fork's .gitmodules lists (relative urls, so they
# resolve to the sibling forks on the same forge).
#
# Credentials (optional: only needed while a fork is private): `user:token` from a BuildKit secret mounted at
# $FORGE_AUTH_FILE (default /run/secrets/forge_auth), or, for native (host) builds, from the FORGE_AUTH environment
# variable.
# It reaches git only through environment variables scoped to the forge's origin: never on a command line, never in
# .git/config, never in an image layer.
set -eu
submodules=0
if [ "${1:-}" = "--submodules" ]; then submodules=1; shift; fi
id="$1"; url="$2"; sha="$3"; dest="$4"
if [ -z "$url" ] || [ "${#sha}" -ne 40 ]; then
  echo "fetch-source: $id needs a git url and a full 40-hex commit sha (got url='$url' sha='$sha')" >&2
  exit 1
fi
auth_file="${FORGE_AUTH_FILE:-/run/secrets/forge_auth}"
credential=""
if [ -r "$auth_file" ]; then credential="$(tr -d '\n' < "$auth_file")"; elif [ -n "${FORGE_AUTH:-}" ]; then credential="$FORGE_AUTH"; fi
if [ -n "$credential" ]; then
  forge="$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+)/.*#\1#')"
  GIT_CONFIG_COUNT=1
  GIT_CONFIG_KEY_0="http.$forge/.extraheader"
  # `base64 | tr -d '\n'`, not GNU-only `base64 -w0`: the same script runs in Linux containers and on macOS hosts.
  GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf '%s' "$credential" | base64 | tr -d '\n')"
  export GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
fi
export GIT_TERMINAL_PROMPT=0

mkdir -p "$dest"
cd "$dest"
git init -q .
git remote add origin "$url"
git fetch -q --depth 1 origin "$sha"
got="$(git rev-parse 'FETCH_HEAD^{commit}')"
if [ "$got" != "$sha" ]; then
  echo "fetch-source: $id fetched $got, pinned $sha ($url)" >&2
  exit 1
fi
git -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
if [ "$submodules" = 1 ]; then
  git submodule update --init --recursive --depth 1
fi
# the tree only: no history, no remote url, no credentials on disk
find . -name .git -prune -exec rm -rf {} +
