#!/bin/bash
# Android libmpv build, step "player" (see env.sh). Run by recipes/android-*/Dockerfile.
set -euo pipefail
. /recipe/env.sh

mkdir -p /work/player
for source in /recipe/jni/*.cpp; do
  "$CXX" -std=c++17 -O2 -fPIC -ffunction-sections -fdata-sections -Werror -I"$PREFIX/include" \
    -c "$source" -o "/work/player/$(basename "$source" .cpp).o"
done
"$CXX" -shared -o "$PREFIX/lib/libplayer.so" -Wl,-soname,libplayer.so /work/player/*.o \
  -L"$PREFIX/lib" -lmpv -lavcodec -lswscale -lavutil -llog -latomic $LDFLAGS_COMMON
readelf -d "$PREFIX/lib/libplayer.so" | grep -E "SONAME|NEEDED"
