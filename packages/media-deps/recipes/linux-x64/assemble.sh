#!/bin/sh
# Collect ffmpeg, ffprobe, mpv and their shared-library closure into ONE flat directory
# (/opt/out/bin), real files only (no symlinks), every ELF RUNPATH=$ORIGIN.
# HOST_LIBRARIES (space-separated shell globs, DepsTarget.hostLibraries) are never bundled: glibc and the
# host graphics stack (GL/EGL, libdrm, X11/xcb, ...) plus the runtime a host GPU driver links (libstdc++, ...).
set -eu
: "${HOST_LIBRARIES:?HOST_LIBRARIES build arg missing (src/plan.ts dockerBuildArgs)}"

OUT=/opt/out/bin
mkdir -p "$OUT"
cp /opt/mpv/bin/mpv /opt/ff/bin/ffmpeg /opt/ff/bin/ffprobe "$OUT/"

export LD_LIBRARY_PATH=/opt/ff/lib:/opt/placebo/lib:/opt/deps/lib

# 0 when $1 matches a HOST_LIBRARIES glob. `set -f`: the globs are patterns here, never expanded against the cwd.
is_host_library() {
  set -f
  for pattern in $HOST_LIBRARIES; do
    # shellcheck disable=SC2254 # unquoted on purpose: $pattern is a case pattern
    case "$1" in $pattern) set +f; return 0 ;; esac
  done
  set +f
  return 1
}

# Walk DT_NEEDED from $1 through bundled libraries only: a host library's own dependencies come from the host
# (it has no $ORIGIN RUNPATH), so a copy of them would never load (lddtree's flat list carried libXau, libXdmcp,
# libbsd and libmd that only the host's libxcb needs, #25). lddtree resolves each soname to its build path.
copy_closure() {
  paths="$(lddtree -l "$1" | grep '^/' | sort -u)"
  queue="$1"
  while [ -n "$queue" ]; do
    current="${queue%% *}"
    if [ "$current" = "$queue" ]; then queue=""; else queue="${queue#* }"; fi
    for name in $(readelf -d "$current" | sed -n 's/.*(NEEDED).*\[\(.*\)\]$/\1/p'); do
      # A private libc loaded by the host's ld-linux breaks on a newer host (glibc 2.44: undefined symbol
      # __nptl_change_stack_perm, #25 P5); a private libdrm/libX11/libstdc++ shadows the one the host GPU driver
      # (loaded into mpv for GPU rendering/decode) was built against (#25).
      if is_host_library "$name"; then
        echo "host library left to the host: $name"
        continue
      fi
      [ -e "$OUT/$name" ] && continue
      dep="$(printf '%s\n' "$paths" | grep -m1 "/$name\$" || true)"
      [ -n "$dep" ] || { echo "unresolved_library: $name (needed by $current)" >&2; exit 1; }
      cp -L "$dep" "$OUT/$name"
      queue="${queue:+$queue }$dep"
    done
  done
}

copy_closure /opt/mpv/bin/mpv
copy_closure /opt/ff/bin/ffmpeg
copy_closure /opt/ff/bin/ffprobe

for f in "$OUT"/*; do
  chmod u+w "$f"
  patchelf --set-rpath '$ORIGIN' "$f"
  strip --strip-unneeded "$f" 2>/dev/null || true
done
chmod 755 "$OUT/mpv" "$OUT/ffmpeg" "$OUT/ffprobe"

# Hard guards: a bundled host library or a leftover symlink fails the build here, not on a user's host.
bad=""
for f in "$OUT"/*; do
  name="$(basename "$f")"
  if is_host_library "$name"; then bad="$bad $name"; fi
done
[ -z "$bad" ] || { echo "bundle_contains_host_library:$bad" >&2; exit 1; }
[ -z "$(find "$OUT" -type l)" ] || { echo "bundle_contains_symlink" >&2; find "$OUT" -type l >&2; exit 1; }
ls -l "$OUT"
