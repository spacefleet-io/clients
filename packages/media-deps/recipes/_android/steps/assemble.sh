#!/bin/bash
# Android libmpv build, step "assemble" (see env.sh). Run by recipes/android-*/Dockerfile.
set -euo pipefail
. /recipe/env.sh

out="/opt/out/lib/$ANDROID_ABI"
mkdir -p "$out"
for name in libavcodec libavfilter libavformat libavutil libswresample libswscale libmpv libplayer; do
  cp -L "$PREFIX/lib/$name.so" "$out/$name.so"
done
cp "$SYSROOT/usr/lib/$ANDROID_TRIPLE/libc++_shared.so" "$out/"
"$TOOLCHAIN/bin/llvm-strip" --strip-unneeded "$out"/*.so
for lib in "$out"/*.so; do
  echo "== $(basename "$lib") $(stat -c %s "$lib") bytes"
  readelf -d "$lib" | grep -E "SONAME|NEEDED" || true
done
du -ch "$out"/*.so | tail -n 1
