# shellcheck shell=bash
# Android libmpv build, shared by android-arm64, android-arm, android-x64 and android-ia32. Each step is `steps/<step>.sh` (sources this
# file), run in its own Docker stage (recipes/android-*/Dockerfile) that copies only that script, so editing one
# step rebuilds from its own layer. Steps, in order:
#   toolchain  download the pinned NDK (NDK_URL, checked against NDK_SHA256) and write the meson cross file
#   libs       dav1d, freetype, harfbuzz, fribidi, expat, fontconfig, libass: static, PIC (linked into libav*/libmpv)
#   ffmpeg     libav{codec,filter,format,util} + libsw{resample,scale}: shared, unversioned sonames (Android)
#   mpv        libplacebo (static) + libmpv.so
#   player     libplayer.so, the JNI bridge `is.xyz.mpv.MPVLib` loads (sources: recipes/_android/jni, from mpv-android)
#   assemble   /opt/out/lib/<ANDROID_ABI>/*.so, stripped, + the NDK's libc++_shared.so
#
# Every library source comes from our forks (recipes/_shared/fetch-source.sh, REL-DEPS-02); the NDK is the toolchain, fetched
# from Google's CDN by a pinned url + sha256. Release build, no debug info, every shared object we link stripped and
# linked with 16 KiB page alignment (Android 15+ 64-bit devices with 16 KiB pages; the NDK's prebuilt 32-bit
# libc++_shared.so is 4 KiB-aligned, which is all a 32-bit system uses).

: "${NDK_VERSION:?}" "${ANDROID_API:?}" "${ANDROID_ABI:?}" "${ANDROID_TRIPLE:?}" "${MESON_CPU_FAMILY:?}"
NDK=/opt/ndk
TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
SYSROOT="$TOOLCHAIN/sysroot"
PREFIX=/opt/deps
CROSS=/opt/cross.ini
# The NDK names the 32-bit ARM clang driver armv7a-linux-androideabi<API>-clang while its sysroot directory (and
# ANDROID_TRIPLE) is arm-linux-androideabi; every other ABI uses one name for both.
CLANG_TRIPLE="${ANDROID_TRIPLE/#arm-linux-androideabi/armv7a-linux-androideabi}"
CC="$TOOLCHAIN/bin/${CLANG_TRIPLE}${ANDROID_API}-clang"
CXX="$TOOLCHAIN/bin/${CLANG_TRIPLE}${ANDROID_API}-clang++"
LDFLAGS_COMMON="-Wl,-z,max-page-size=16384 -Wl,--gc-sections -Wl,--build-id=sha1"
# pkg-config sees ONLY the build prefix: nothing from the build host can be linked.
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export PKG_CONFIG_PATH=""
MESON=(--cross-file "$CROSS" --prefix="$PREFIX" --libdir=lib --buildtype=release -Db_ndebug=true -Db_staticpic=true
  --default-library=static)
CMAKE=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_LIBDIR=lib
  -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" -DANDROID_ABI="$ANDROID_ABI"
  -DANDROID_PLATFORM="android-$ANDROID_API" -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  -DCMAKE_FIND_ROOT_PATH="$PREFIX")

meson_build() { # <name> [meson options...]: configure, build and install /work/<name> (static, cross)
  local name="$1"; shift
  meson setup "/work/$name/build" "/work/$name" "${MESON[@]}" "$@"
  meson compile -C "/work/$name/build"
  meson install -C "/work/$name/build"
}

