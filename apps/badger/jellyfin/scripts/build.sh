#!/usr/bin/env bash
# Builds the Badger Jellyfin plugin zip, the Jellyfin plugin-repository manifest.json and the sidecar downloads.
#
#   apps/badger/jellyfin/scripts/build.sh [--skip-service] [--base-url <url>]
#
# --base-url   where the Badger API serves /integrations/jellyfin from (default https://api.spacefleet.io).
#              The manifest's sourceUrl becomes <base-url>/integrations/jellyfin/plugin/spacebadger_<version>.zip,
#              so users add <base-url>/integrations/jellyfin/manifest.json as their Jellyfin plugin repository.
# --skip-service  reuse the sidecar binaries already in apps/badger/jellyfin/sidecar/dist instead of rebuilding them.
#
# Needs docker (the .NET SDK runs in mcr.microsoft.com/dotnet/sdk:10.0) and bun (compiles the Badger service).
# The plugin zip holds only the plugin: the sidecar for the server's platform is downloaded by the plugin (INTG-JF-04).
# Output in apps/badger/jellyfin/dist/:
#   spacebadger_<version>.zip, manifest.json
#   release/  the flat release attachments (release-assets.py): sidecar-<version>-<platform>,
#             sidecar-<version>-manifest.json (sha256 + size per platform), spacebadger_<version>.zip, manifest.json
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(cd "$here/../../.." && pwd)"
sidecar="$repo/apps/badger/jellyfin/sidecar"
project="$here/Jellyfin.Plugin.SpaceBadger"
dist="$here/dist"
skip_service=0
base_url="https://api.spacefleet.io"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-service) skip_service=1 ;;
    --base-url) base_url="${2%/}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

version="$(sed -n 's/.*"version": "\(.*\)",\?/\1/p' "$project/meta.json" | head -1)"
target_abi="$(sed -n 's/.*"targetAbi": "\(.*\)",\?/\1/p' "$project/meta.json" | head -1)"
guid="$(sed -n 's/.*"guid": "\(.*\)",\?/\1/p' "$project/meta.json" | head -1)"
changelog="$(sed -n 's/.*"changelog": "\(.*\)",\?/\1/p' "$project/meta.json" | head -1)"
zip_name="spacebadger_${version}.zip"
source_url="$base_url/integrations/jellyfin/plugin/$zip_name"

echo "[build] plugin $version (targetAbi $target_abi)"
rm -rf "$dist" "$project/bin" "$project/obj"
mkdir -p "$dist/plugin"

# No bind mounts: the CI runner's docker daemon (dind-rootless) cannot mount the checkout ("mkdir /workspace: permission
# denied"). The project is sent as a build context, published inside `docker build`, and the
# dll is copied out with `docker cp`.
echo "[build] compiling the plugin (docker build, dotnet 10)"
ctx="$(mktemp -d)"
image="spacebadger-jellyfin-plugin-build:$$"
container=""
cleanup() {
  [ -z "$container" ] || docker rm -f "$container" >/dev/null 2>&1 || true
  docker rmi -f "$image" >/dev/null 2>&1 || true
  rm -rf "$ctx"
}
trap cleanup EXIT
cp -r "$project" "$ctx/Jellyfin.Plugin.SpaceBadger"
cat > "$ctx/Dockerfile" <<'DOCKERFILE'
FROM mcr.microsoft.com/dotnet/sdk:10.0
ENV DOTNET_NOLOGO=1 DOTNET_CLI_TELEMETRY_OPTOUT=1
WORKDIR /src/Jellyfin.Plugin.SpaceBadger
COPY Jellyfin.Plugin.SpaceBadger/ ./
RUN dotnet publish -c Release -o /out
DOCKERFILE
docker build -q -t "$image" "$ctx" >/dev/null
container="$(docker create "$image")"
docker cp "$container:/out/Jellyfin.Plugin.SpaceBadger.dll" "$dist/plugin/"
cp "$project/meta.json" "$dist/plugin/"
cp "$project/Configuration/qrcode.LICENSE.txt" "$dist/plugin/qrcode.LICENSE.txt"
cp "$here/LICENSE" "$dist/plugin/LICENSE"

if [ "$skip_service" -eq 0 ]; then
  echo "[build] compiling the Badger service (linux-x64, linux-arm64, windows-x64)"
  (cd "$sidecar" && bun run build:integration)
fi

echo "[build] zipping"
(cd "$dist/plugin" && rm -f "../$zip_name" && python3 - "../$zip_name" <<'PY'
import os, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as archive:
    for folder, _, files in os.walk("."):
        for name in sorted(files):
            path = os.path.join(folder, name)
            info = zipfile.ZipInfo.from_file(path, os.path.relpath(path, "."))
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(path, "rb") as handle:
                archive.writestr(info, handle.read())
PY
)
echo "[build] zipped $zip_name"
checksum="$(md5sum "$dist/$zip_name" | cut -d' ' -f1)"
timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > "$dist/manifest.json" <<EOF
[
  {
    "guid": "$guid",
    "name": "Badger",
    "description": "Plays your Badger library in Jellyfin.",
    "overview": "Your Badger library as Jellyfin libraries, with resume and watched sync.",
    "owner": "Badger",
    "category": "General",
    "versions": [
      {
        "version": "$version",
        "changelog": "$changelog",
        "targetAbi": "$target_abi",
        "sourceUrl": "$source_url",
        "checksum": "$checksum",
        "timestamp": "$timestamp"
      }
    ]
  }
]
EOF

if [ -f "$sidecar/dist/badger-integration-linux-x64" ] && [ -f "$sidecar/dist/badger-integration-linux-arm64" ] && [ -f "$sidecar/dist/badger-integration-windows-x64.exe" ]; then
  echo "[build] collecting the release attachments"
  python3 "$here/scripts/release-assets.py" --plugin-dist "$dist" --sidecar-dir "$sidecar/dist" --out "$dist/release"
else
  echo "[build] sidecar binaries not all present in $sidecar/dist; skipping dist/release (run release-assets.py after building them)"
fi

echo "[build] done"
echo "  zip:      $dist/$zip_name"
echo "  md5:      $checksum"
echo "  manifest: $dist/manifest.json (sourceUrl $source_url)"
if [ -d "$dist/release" ]; then echo "  release:  $dist/release"; fi
