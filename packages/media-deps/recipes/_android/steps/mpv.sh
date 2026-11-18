#!/bin/bash
# Android libmpv build, step "mpv" (see env.sh). Run by recipes/android-*/Dockerfile.
set -euo pipefail
. /recipe/env.sh

: "${LIBPLACEBO_MESON_OPTIONS:?}" "${MPV_MESON_OPTIONS:?}"
fetch-source --submodules libplacebo "$SRC_LIBPLACEBO_URL" "$SRC_LIBPLACEBO_SHA" /work/libplacebo
# shellcheck disable=SC2086 # option list
meson_build libplacebo $LIBPLACEBO_MESON_OPTIONS
# Static libplacebo carries C++ objects: whoever links it (libmpv.so) needs the C++ runtime (libc++_shared.so).
sed -i '/^Libs:/ s/$/ -lc++/' "$PREFIX/lib/pkgconfig/libplacebo.pc"

fetch-source mpv "$SRC_MPV_URL" "$SRC_MPV_SHA" /work/mpv
# shellcheck disable=SC2086 # option list
meson setup /work/mpv/build /work/mpv --cross-file "$CROSS" --prefix="$PREFIX" --libdir=lib --buildtype=release \
  -Db_ndebug=true --default-library=shared \
  -Dc_link_args="-L$PREFIX/lib -Wl,--exclude-libs,ALL $LDFLAGS_COMMON" \
  $MPV_MESON_OPTIONS
meson compile -C /work/mpv/build
meson install -C /work/mpv/build
# Android loads libraries by file name: meson already links an unversioned libmpv.so (soname libmpv.so) for an
# android host machine. Refuse anything else: libplayer records this soname as its NEEDED entry.
readelf -d "$PREFIX/lib/libmpv.so" | grep -E "SONAME|NEEDED"
readelf -d "$PREFIX/lib/libmpv.so" | grep -q "Library soname: \[libmpv.so\]" || {
  echo "mpv: libmpv.so soname is not libmpv.so" >&2
  exit 1
}
