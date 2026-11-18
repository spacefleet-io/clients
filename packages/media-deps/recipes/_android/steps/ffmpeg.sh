#!/bin/bash
# Android libmpv build, step "ffmpeg" (see env.sh). Run by recipes/android-*/Dockerfile.
set -euo pipefail
. /recipe/env.sh

: "${FFMPEG_FLAGS:?}"
# `ffmpegmobile`: the 8.1.3 release tree + our HLS seek patch (src/sources.ts).
fetch-source ffmpegmobile "$SRC_FFMPEGMOBILE_URL" "$SRC_FFMPEGMOBILE_SHA" /work/ffmpeg
cd /work/ffmpeg
# --target-os=android (in FFMPEG_FLAGS) gives unversioned sonames (libavcodec.so): Android loads by file name.
# shellcheck disable=SC2086 # FFMPEG_FLAGS is a flag list
./configure --prefix="$PREFIX" \
  --cc="$CC" --cxx="$CXX" --ar="$TOOLCHAIN/bin/llvm-ar" --nm="$TOOLCHAIN/bin/llvm-nm" \
  --ranlib="$TOOLCHAIN/bin/llvm-ranlib" --strip="$TOOLCHAIN/bin/llvm-strip" --sysroot="$SYSROOT" \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --enable-pic --enable-shared --disable-static \
  --extra-cflags="-I$PREFIX/include -ffunction-sections -fdata-sections" \
  --extra-ldflags="-L$PREFIX/lib -Wl,--exclude-libs,ALL $LDFLAGS_COMMON" \
  $FFMPEG_FLAGS \
  || { tail -n 80 ffbuild/config.log >&2; exit 1; }
make -j"$(nproc)"
make install
grep -m1 "FFMPEG_CONFIGURATION" config.h
