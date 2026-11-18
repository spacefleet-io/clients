#!/bin/bash
# macOS recipe (macos-arm64 and macos-x64): reduced ffmpeg + ffprobe + mpv from the shared feature list, built
# NATIVELY on an Apple Silicon Mac (no Docker). x64 is a cross build (`-arch x86_64`); configure/meson test
# programs and LuaJIT's buildvm of the x64 build run through Rosetta 2.
#
#   recipes/macos-<arch>/build.sh <outdir>      (src/plan.ts runs it with every resolved build arg in the env)
#
# Output (`<outdir>`), the layout the macOS platform layer and packaging read:
#   bin/ffmpeg bin/ffprobe bin/sf-lifeline            LC_RPATH @loader_path/../lib
#   lib/*.dylib                                        install name @rpath/<file>, LC_RPATH @loader_path
#   Badger Player.app/Contents/{Info.plist,MacOS/mpv,Resources/icon.icns}   (REL-MAC-09: "Badger Player" in the Dock)
#                                                      mpv LC_RPATHs @executable_path/../../../lib and
#                                                      @executable_path/../../../../Resources/deps/lib (packaged)
# Every Mach-O: release + LTO, stripped, minos 14.0, ad-hoc signed; links only the bundle, /usr/lib and /System.
# Codec libraries (x264, x265, lame, dav1d) are static inside libavcodec; libplacebo, shaderc, libass, freetype,
# harfbuzz, fribidi, zimg and LuaJIT are static inside mpv; MoltenVK is the one non-FFmpeg dylib. zlib and iconv
# are the copies macOS ships (/usr/lib).
#
# Env (src/plan.ts): SRC_<ID>_URL / SRC_<ID>_SHA, FFMPEG_FLAGS, LIBPLACEBO_MESON_OPTIONS, MPV_MESON_OPTIONS,
# MAC_ARCH (arm64 | x86_64), MACOS_MIN, XCODE_VERSION, MACOS_SDK_VERSION, FORGE_AUTH (read by fetch-source).
# MEDIA_DEPS_WORK_DIR (optional): keep sources + build trees there and skip finished steps (local iteration).
set -euo pipefail

OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$PKG/../.." && pwd)"
: "${MAC_ARCH:?}" "${MACOS_MIN:?}" "${XCODE_VERSION:?}" "${MACOS_SDK_VERSION:?}"
: "${FFMPEG_FLAGS:?}" "${LIBPLACEBO_MESON_OPTIONS:?}" "${MPV_MESON_OPTIONS:?}"

# ---- toolchain: the pinned Xcode / SDK (part of the recipe hash) --------------------------------------------
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
xcode="$(xcodebuild -version | sed -n 's/^Xcode //p')"
sdk_version="$(xcrun --sdk macosx --show-sdk-version)"
if [ "$xcode" != "$XCODE_VERSION" ] || [ "$sdk_version" != "$MACOS_SDK_VERSION" ]; then
  echo "macos recipe: needs Xcode $XCODE_VERSION / macOS SDK $MACOS_SDK_VERSION, found Xcode $xcode / SDK $sdk_version" >&2
  echo "(the Xcode/SDK pair is part of the published version: change recipes/_macos/macosTarget.ts to move it)" >&2
  exit 1
fi
SDKROOT="$(xcrun --sdk macosx --show-sdk-path)"
export SDKROOT MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN"

if [ -n "${MEDIA_DEPS_WORK_DIR:-}" ]; then
  WORK="$(mkdir -p "$MEDIA_DEPS_WORK_DIR" && cd "$MEDIA_DEPS_WORK_DIR" && pwd)"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/media-deps-macos.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
fi
SRC="$WORK/src" PREFIX="$WORK/prefix" FF="$WORK/ff" MPV="$WORK/mpv"
mkdir -p "$SRC" "$PREFIX/lib/pkgconfig" "$WORK/stamps" "$WORK/tools"
JOBS="$(sysctl -n hw.ncpu)"

# Hermetic PATH: only the build tools below plus the OS. Nothing from Homebrew's lib/include/pkgconfig can leak in
# (pkg-config sees $PREFIX only; the compilers never search /opt/homebrew or /usr/local).
for tool in meson ninja cmake nasm pkg-config autoreconf autoconf autoheader autom4te automake aclocal glibtoolize python3; do
  found="$(command -v "$tool" || true)"
  [ -n "$found" ] || { echo "macos recipe: build tool '$tool' missing (brew install meson ninja cmake nasm pkgconf autoconf automake libtool)" >&2; exit 1; }
  ln -sf "$found" "$WORK/tools/$tool"
done
ln -sf "$WORK/tools/glibtoolize" "$WORK/tools/libtoolize"
export PATH="$WORK/tools:/usr/bin:/bin:/usr/sbin:/sbin"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$FF/lib/pkgconfig" PKG_CONFIG_PATH=""
export GIT_CEILING_DIRECTORIES="$WORK"

ARCH_FLAGS="-arch $MAC_ARCH -mmacosx-version-min=$MACOS_MIN -isysroot $SDKROOT"
OPT_FLAGS="-O2 -flto=thin"
export CC=clang CXX=clang++ OBJC=clang OBJCXX=clang++
export CFLAGS="$ARCH_FLAGS $OPT_FLAGS -I$PREFIX/include" CXXFLAGS="$ARCH_FLAGS $OPT_FLAGS -I$PREFIX/include"
export OBJCFLAGS="$CFLAGS" LDFLAGS="$ARCH_FLAGS -flto=thin -L$PREFIX/lib -Wl,-dead_strip"

# Autotools: host = the target, build = this arm64 Mac (equal for arm64: a native build). Bash 3.2 (macOS /bin/bash)
# treats an empty "${array[@]}" as unbound under `set -u`, so the per-arch values are plain strings.
AUTOCONF_BUILD=--build=aarch64-apple-darwin
if [ "$MAC_ARCH" = x86_64 ]; then
  HOST_TRIPLE=x86_64-apple-darwin
  MESON_MACHINE=--cross-file
else
  HOST_TRIPLE=aarch64-apple-darwin
  MESON_MACHINE=--native-file
fi
AUTOCONF_HOST="--host=$HOST_TRIPLE"

# meson machine file: the same compilers and flags whether native (arm64) or cross (x86_64, run via Rosetta).
quote_list() { local out="" item; for item in "$@"; do out="$out'$item', "; done; printf '[%s]' "${out%, }"; }
# shellcheck disable=SC2086
{
  echo "[binaries]"
  echo "c = 'clang'"; echo "cpp = 'clang++'"; echo "objc = 'clang'"; echo "objcpp = 'clang++'"
  echo "ar = 'ar'"; echo "strip = 'strip'"; echo "pkg-config = 'pkg-config'"; echo "nasm = 'nasm'"
  echo "[built-in options]"
  for lang in c cpp objc objcpp; do
    echo "${lang}_args = $(quote_list $ARCH_FLAGS -I$PREFIX/include)"
    echo "${lang}_link_args = $(quote_list $ARCH_FLAGS -L$PREFIX/lib -Wl,-dead_strip)"
  done
  echo "[properties]"
  echo "needs_exe_wrapper = false"
  echo "pkg_config_libdir = '$PKG_CONFIG_LIBDIR'"
  if [ "$MAC_ARCH" = x86_64 ]; then
    echo "[host_machine]"
    echo "system = 'darwin'"; echo "subsystem = 'macos'"; echo "kernel = 'xnu'"
    echo "cpu_family = 'x86_64'"; echo "cpu = 'x86_64'"; echo "endian = 'little'"
  fi
} > "$WORK/meson.ini"
MESON=(--prefix="$PREFIX" --libdir=lib --buildtype=release -Db_ndebug=true -Db_lto=true -Db_lto_mode=thin "$MESON_MACHINE" "$WORK/meson.ini")
CMAKE=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_LIBDIR=lib
  -DCMAKE_OSX_ARCHITECTURES="$MAC_ARCH" -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOS_MIN" -DCMAKE_OSX_SYSROOT="$SDKROOT"
  -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5
  -DCMAKE_PREFIX_PATH="$PREFIX" -DCMAKE_IGNORE_PREFIX_PATH="/opt/homebrew;/usr/local" -DCMAKE_FIND_FRAMEWORK=LAST)
# x86_64 on the arm64 host: tell CMake it cross-compiles (x265 picks its x86 assembly from the processor).
[ "$MAC_ARCH" = x86_64 ] && CMAKE+=(-DCMAKE_SYSTEM_NAME=Darwin -DCMAKE_SYSTEM_PROCESSOR=x86_64)

fetch-source() { sh "$PKG/recipes/_shared/fetch-source.sh" "$@"; }
# step <name>: false when the step already finished in a kept MEDIA_DEPS_WORK_DIR.
step() { if [ -e "$WORK/stamps/$1" ]; then echo "[macos] skip $1 (done)"; return 1; fi; echo "[macos] ---- $1"; rm -rf "${SRC:?}/$1"; }
done_step() { touch "$WORK/stamps/$1"; }

# ---- static codec libraries (linked into libavcodec) ---------------------------------------------------------
if step x264; then
  fetch-source x264 "$SRC_X264_URL" "$SRC_X264_SHA" "$SRC/x264"
  # arm64 assembles with clang (needs the arch flags); x86_64 with nasm, which rejects -arch/-isysroot.
  X264_ASFLAGS=""
  [ "$MAC_ARCH" = arm64 ] && X264_ASFLAGS="$ARCH_FLAGS"
  # NO LTO for x264 (REL-DEPS-10 fallback): under LTO clang miscompiles its PREALLOC_* offset-then-rebase
  # pointer pattern in x264_macroblock_cache_allocate (memset on NULL+offset, SIGSEGV on every libx264 encode).
  (cd "$SRC/x264" && CFLAGS="$ARCH_FLAGS -O2 -I$PREFIX/include" LDFLAGS="$ARCH_FLAGS" ./configure --prefix="$PREFIX" \
     --host="$HOST_TRIPLE" --enable-static --enable-pic \
     --disable-cli --disable-opencl --bit-depth=8 --chroma-format=420 \
     --extra-cflags="$ARCH_FLAGS" --extra-ldflags="$ARCH_FLAGS" --extra-asflags="$X264_ASFLAGS" \
   && make -j"$JOBS" && make install)
  done_step x264
fi

if step x265; then
  fetch-source x265macos "$SRC_X265MACOS_URL" "$SRC_X265MACOS_SHA" "$SRC/x265"
  cmake -S "$SRC/x265/source" -B "$SRC/x265/build" "${CMAKE[@]}" \
    -DENABLE_SHARED=OFF -DENABLE_CLI=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON
  cmake --build "$SRC/x265/build" && cmake --install "$SRC/x265/build"
  done_step x265
fi

if step lame; then
  fetch-source lame "$SRC_LAME_URL" "$SRC_LAME_SHA" "$SRC/lame"
  (cd "$SRC/lame" && ./configure --prefix="$PREFIX" "$AUTOCONF_HOST" "$AUTOCONF_BUILD" --enable-static --disable-shared --with-pic \
     --disable-frontend --disable-gtktest --disable-decoder \
   && make -j"$JOBS" && make install)
  done_step lame
fi

if step dav1d; then
  fetch-source dav1d "$SRC_DAV1D_URL" "$SRC_DAV1D_SHA" "$SRC/dav1d"
  meson setup "$SRC/dav1d/build" "$SRC/dav1d" "${MESON[@]}" --default-library=static \
    -Denable_tools=false -Denable_tests=false -Denable_examples=false
  meson compile -C "$SRC/dav1d/build" && meson install -C "$SRC/dav1d/build"
  done_step dav1d
fi

# ---- ffmpeg + ffprobe (shared libs, shared with mpv) ---------------------------------------------------------
if step ffmpeg; then
  fetch-source ffmpeg "$SRC_FFMPEG_URL" "$SRC_FFMPEG_SHA" "$SRC/ffmpeg"
  # shellcheck disable=SC2086
  (cd "$SRC/ffmpeg" && ./configure --prefix="$FF" --enable-shared --disable-static --enable-pic --enable-lto=thin \
     --install-name-dir=@rpath --pkg-config=pkg-config --pkg-config-flags=--static \
     --cc=clang --cxx=clang++ --objcc=clang \
     --extra-cflags="$ARCH_FLAGS -I$PREFIX/include" --extra-objcflags="$ARCH_FLAGS" \
     --extra-ldflags="$ARCH_FLAGS -L$PREFIX/lib -Wl,-dead_strip" \
     $FFMPEG_FLAGS \
   && make -j"$JOBS" && make install)
  # mpv links the dylibs: their private (static) dependencies must not leak into its link line.
  sed -i '' -e '/^Libs\.private:/d' -e '/^Requires\.private:/d' "$FF"/lib/pkgconfig/*.pc
  done_step ffmpeg
fi

# ---- mpv's own dependencies: static libraries ------------------------------------------------------------------
if step freetype; then
  fetch-source freetype "$SRC_FREETYPE_URL" "$SRC_FREETYPE_SHA" "$SRC/freetype"
  meson setup "$SRC/freetype/build" "$SRC/freetype" "${MESON[@]}" --default-library=static \
    -Dzlib=system -Dbzip2=disabled -Dpng=disabled -Dharfbuzz=disabled -Dbrotli=disabled -Dmmap=enabled -Dtests=disabled
  meson compile -C "$SRC/freetype/build" && meson install -C "$SRC/freetype/build"
  done_step freetype
fi

if step harfbuzz; then
  fetch-source harfbuzz "$SRC_HARFBUZZ_URL" "$SRC_HARFBUZZ_SHA" "$SRC/harfbuzz"
  meson setup "$SRC/harfbuzz/build" "$SRC/harfbuzz" "${MESON[@]}" --default-library=static \
    -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled -Dcoretext=disabled \
    -Dchafa=disabled -Dgraphite2=disabled -Dtests=disabled -Ddocs=disabled -Dbenchmark=disabled -Dutilities=disabled \
    -Dintrospection=disabled
  meson compile -C "$SRC/harfbuzz/build" && meson install -C "$SRC/harfbuzz/build"
  done_step harfbuzz
fi

if step fribidi; then
  fetch-source fribidi "$SRC_FRIBIDI_URL" "$SRC_FRIBIDI_SHA" "$SRC/fribidi"
  meson setup "$SRC/fribidi/build" "$SRC/fribidi" "${MESON[@]}" --default-library=static -Dtests=false -Ddocs=false -Dbin=false
  meson compile -C "$SRC/fribidi/build" && meson install -C "$SRC/fribidi/build"
  done_step fribidi
fi

# libass finds fonts through CoreText (system framework): no fontconfig, no font files shipped.
if step libass; then
  fetch-source libass "$SRC_LIBASS_URL" "$SRC_LIBASS_SHA" "$SRC/libass"
  # The fork carries libass's generated autotools files, and a git checkout gives them arbitrary mtimes: make may then
  # see aclocal.m4 as older than configure.ac / m4/*.m4 and call aclocal-1.17, which the runner does not have. Stamp
  # them in dependency order (aclocal.m4, then configure, then Makefile.in / config.h.in) so make never regenerates.
  (cd "$SRC/libass" && touch aclocal.m4 && touch configure && find . \( -name Makefile.in -o -name config.h.in \) -exec touch {} +)
  (cd "$SRC/libass" && ./configure --prefix="$PREFIX" "$AUTOCONF_HOST" "$AUTOCONF_BUILD" --enable-static --disable-shared \
     --disable-fontconfig --enable-coretext --disable-libunibreak --disable-require-system-font-provider \
   && make -j"$JOBS" && make install)
  done_step libass
fi

if step zimg; then
  fetch-source zimg "$SRC_ZIMG_URL" "$SRC_ZIMG_SHA" "$SRC/zimg"
  (cd "$SRC/zimg" && ./autogen.sh && ./configure --prefix="$PREFIX" "$AUTOCONF_HOST" "$AUTOCONF_BUILD" --enable-static --disable-shared \
   && make -j"$JOBS" && make install)
  done_step zimg
fi

# LuaJIT: its own Makefile and flags (the interpreter is generated assembly: no LTO). buildvm runs on the build
# machine for the TARGET architecture, so the x86_64 one runs under Rosetta.
if step luajit; then
  fetch-source luajit "$SRC_LUAJIT_URL" "$SRC_LUAJIT_SHA" "$SRC/luajit"
  luajit_make=(MACOSX_DEPLOYMENT_TARGET="$MACOS_MIN" PREFIX="$PREFIX" BUILDMODE=static CFLAGS= LDFLAGS=
    CC="clang -arch $MAC_ARCH -isysroot $SDKROOT" HOST_CC="clang -arch $MAC_ARCH" TARGET_STRIP=:)
  make -C "$SRC/luajit" -j"$JOBS" amalg "${luajit_make[@]}"
  make -C "$SRC/luajit" install "${luajit_make[@]}"
  done_step luajit
fi

# ---- Vulkan on Metal: MoltenVK (dylib) + the GLSL compiler libplacebo needs (shaderc, static) -----------------
if step vulkanheaders; then
  fetch-source vulkanheaders "$SRC_VULKANHEADERS_URL" "$SRC_VULKANHEADERS_SHA" "$SRC/vulkanheaders"
  cmake -S "$SRC/vulkanheaders" -B "$SRC/vulkanheaders/build" "${CMAKE[@]}" -DVULKAN_HEADERS_ENABLE_MODULE=OFF -DVULKAN_HEADERS_ENABLE_TESTS=OFF
  cmake --install "$SRC/vulkanheaders/build"
  done_step vulkanheaders
fi

# MoltenVK pulls its dependencies through CPM (network). Our CPM stand-in (cpm.cmake) maps each one to the
# pinned fork tree instead. SPIRV-Tools (debug disassembly only) is excluded; cereal (header-only) is required:
# without it vkCreatePipelineCache fails and libplacebo cannot create a single render pass (no frame is drawn).
if step moltenvk; then
  rm -rf "$SRC/moltenvk-spirv-cross" "$SRC/cereal"
  fetch-source moltenvk "$SRC_MOLTENVK_URL" "$SRC_MOLTENVK_SHA" "$SRC/moltenvk"
  fetch-source moltenvkspirvcross "$SRC_MOLTENVKSPIRVCROSS_URL" "$SRC_MOLTENVKSPIRVCROSS_SHA" "$SRC/moltenvk-spirv-cross"
  fetch-source cereal "$SRC_CEREAL_URL" "$SRC_CEREAL_SHA" "$SRC/cereal"
  cpm_version="$(sed -n 's/^set(CPM_DOWNLOAD_VERSION \(.*\))$/\1/p' "$SRC/moltenvk/cmake/recipes/CPM.cmake")"
  mkdir -p "$WORK/cpm/cpm"
  cp "$HERE/cpm.cmake" "$WORK/cpm/cpm/CPM_${cpm_version}.cmake"
  cmake -S "$SRC/moltenvk" -B "$SRC/moltenvk/build" "${CMAKE[@]}" -DCPM_SOURCE_CACHE="$WORK/cpm" \
    -DSF_SOURCE_SPIRV-Cross="$SRC/moltenvk-spirv-cross" -DSF_SOURCE_Vulkan-Headers="$SRC/vulkanheaders" \
    -DSF_SOURCE_cereal="$SRC/cereal" \
    -DMVK_EXCLUDE_SPIRV_TOOLS=ON -DMVK_BUILD_SHADER_CONVERTER_TOOL=OFF \
    -DMOLTEN_VK_WITH_CCACHE=OFF -DMVK_CONFIG_LOG_LEVEL=warn
  cmake --build "$SRC/moltenvk/build" && cmake --install "$SRC/moltenvk/build"
  # libplacebo and mpv link MoltenVK directly as their Vulkan library (no loader, no ICD lookup at run time).
  cat > "$PREFIX/lib/pkgconfig/vulkan.pc" <<EOF
prefix=$PREFIX
includedir=\${prefix}/include
libdir=\${prefix}/lib

Name: vulkan
Description: Vulkan on Metal (MoltenVK $(sed -n 's/^Version: //p' "$PREFIX/lib/pkgconfig/MoltenVK.pc"))
Version: $(sed -n 's/^#define VK_HEADER_VERSION_COMPLETE VK_MAKE_API_VERSION(0, \([0-9]*\), \([0-9]*\), VK_HEADER_VERSION)$/\1.\2/p' "$PREFIX/include/vulkan/vulkan_core.h").$(sed -n 's/^#define VK_HEADER_VERSION \([0-9]*\)$/\1/p' "$PREFIX/include/vulkan/vulkan_core.h")
Libs: -L\${libdir} -lMoltenVK
Cflags: -I\${includedir}
EOF
  done_step moltenvk
fi

if step shaderc; then
  fetch-source shaderc "$SRC_SHADERC_URL" "$SRC_SHADERC_SHA" "$SRC/shaderc"
  fetch-source glslang "$SRC_GLSLANG_URL" "$SRC_GLSLANG_SHA" "$SRC/shaderc/third_party/glslang"
  fetch-source spirvtools "$SRC_SPIRVTOOLS_URL" "$SRC_SPIRVTOOLS_SHA" "$SRC/shaderc/third_party/spirv-tools"
  fetch-source spirvheaders "$SRC_SPIRVHEADERS_URL" "$SRC_SPIRVHEADERS_SHA" "$SRC/shaderc/third_party/spirv-headers"
  cmake -S "$SRC/shaderc" -B "$SRC/shaderc/build" "${CMAKE[@]}" -DBUILD_SHARED_LIBS=OFF \
    -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DSHADERC_SKIP_COPYRIGHT_CHECK=ON \
    -DSHADERC_SKIP_EXECUTABLES=ON -DSPIRV_SKIP_TESTS=ON -DSPIRV_SKIP_EXECUTABLES=ON \
    -DSPIRV_WERROR=OFF -DENABLE_GLSLANG_BINARIES=OFF -DSHADERC_ENABLE_WERROR_COMPILE=OFF \
    -DENABLE_HLSL=OFF -DENABLE_OPT=ON -DENABLE_SPVREMAPPER=OFF
  cmake --build "$SRC/shaderc/build" && cmake --install "$SRC/shaderc/build"
  # One static archive (shaderc + glslang + SPIRV-Tools) linked into mpv; never the dylib.
  rm -f "$PREFIX"/lib/libshaderc_shared*.dylib
  cp "$PREFIX/lib/pkgconfig/shaderc_combined.pc" "$PREFIX/lib/pkgconfig/shaderc.pc"
  done_step shaderc
fi

# ---- libplacebo + mpv ------------------------------------------------------------------------------------------
if step libplacebo; then
  fetch-source --submodules libplacebo "$SRC_LIBPLACEBO_URL" "$SRC_LIBPLACEBO_SHA" "$SRC/libplacebo"
  # shellcheck disable=SC2086
  meson setup "$SRC/libplacebo/build" "$SRC/libplacebo" "${MESON[@]}" --default-library=static $LIBPLACEBO_MESON_OPTIONS
  meson compile -C "$SRC/libplacebo/build" && meson install -C "$SRC/libplacebo/build"
  done_step libplacebo
fi

if step mpv; then
  fetch-source mpv "$SRC_MPV_URL" "$SRC_MPV_SHA" "$SRC/mpv"
  # The build-time rpaths let meson's own checks run what they link; assemble replaces them.
  # shellcheck disable=SC2086
  meson setup "$SRC/mpv/build" "$SRC/mpv" "${MESON[@]}" --prefix="$MPV" --default-library=static \
    -Dc_link_args="$ARCH_FLAGS -L$PREFIX/lib -Wl,-dead_strip -Wl,-rpath,$FF/lib -Wl,-rpath,$PREFIX/lib" \
    -Dobjc_link_args="$ARCH_FLAGS -L$PREFIX/lib -Wl,-dead_strip -Wl,-rpath,$FF/lib -Wl,-rpath,$PREFIX/lib" \
    -Dswift-flags="-target $MAC_ARCH-apple-macos$MACOS_MIN" \
    $MPV_MESON_OPTIONS
  meson compile -C "$SRC/mpv/build" && meson install -C "$SRC/mpv/build"
  done_step mpv
fi

# ---- sf-lifeline (RT-LIFE-06): the macOS parent-death guard the platform layer wraps ffmpeg with ----------------
clang $ARCH_FLAGS -O2 -flto=thin -Wall -Werror -o "$WORK/sf-lifeline" "$REPO/packages/desktop-platform-macos/native/sf-lifeline.c"

# ---- assemble ----------------------------------------------------------------------------------------------------
APP="$OUT/Badger Player.app"
rm -rf "$OUT/bin" "$OUT/lib" "$APP"
mkdir -p "$OUT/bin" "$OUT/lib" "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$FF/bin/ffmpeg" "$FF/bin/ffprobe" "$WORK/sf-lifeline" "$OUT/bin/"
cp "$MPV/bin/mpv" "$APP/Contents/MacOS/mpv"

deps_of() { otool -L "$1" | tail -n +2 | awk '{print $1}'; }
rpaths_of() { otool -l "$1" | awk '/cmd LC_RPATH/{getline; getline; print $2}'; }
is_system() { case "$1" in /usr/lib/*|/System/*) return 0 ;; *) return 1 ;; esac; }
# Copy every non-system dylib the binaries need into lib/ (real files named after their install name), then
# rewrite every reference to @rpath/<file>.
queue=("$OUT/bin/ffmpeg" "$OUT/bin/ffprobe" "$OUT/bin/sf-lifeline" "$APP/Contents/MacOS/mpv")
i=0
while [ "$i" -lt "${#queue[@]}" ]; do
  file="${queue[$i]}"; i=$((i + 1))
  own_id="$(otool -D "$file" | tail -n +2)"
  while read -r dep; do
    [ -n "$dep" ] && [ "$dep" != "$own_id" ] || continue
    is_system "$dep" && continue
    name="$(basename "$dep")"
    case "$dep" in
      @rpath/*|"$WORK"/*) ;;
      *) echo "assemble: $(basename "$file") links $dep (outside the bundle and not a macOS system library)" >&2; exit 1 ;;
    esac
    if [ ! -e "$OUT/lib/$name" ]; then
      src=""
      for dir in "$FF/lib" "$PREFIX/lib"; do [ -e "$dir/$name" ] && { src="$dir/$name"; break; }; done
      [ -n "$src" ] || { echo "assemble: $name (needed by $(basename "$file")) not found" >&2; exit 1; }
      cp -L "$src" "$OUT/lib/$name"
      chmod 644 "$OUT/lib/$name"
      queue+=("$OUT/lib/$name")
    fi
    [ "$dep" = "@rpath/$name" ] || install_name_tool -change "$dep" "@rpath/$name" "$file"
  done < <(deps_of "$file")
done

relink() { # <file> <rpath>...
  local file="$1" rp; shift
  while read -r rp; do [ -n "$rp" ] && install_name_tool -delete_rpath "$rp" "$file"; done < <(rpaths_of "$file")
  for rp in "$@"; do install_name_tool -add_rpath "$rp" "$file"; done
}
for lib in "$OUT"/lib/*.dylib; do
  strip -x "$lib"
  install_name_tool -id "@rpath/$(basename "$lib")" "$lib"
  relink "$lib" @loader_path
done
for exe in "$OUT"/bin/*; do strip "$exe"; relink "$exe" @loader_path/../lib; done
strip -x "$APP/Contents/MacOS/mpv"
relink "$APP/Contents/MacOS/mpv" @executable_path/../../../lib @executable_path/../../../../Resources/deps/lib

# The helper app: its own name, id and icon in the Dock / app switcher (MPV-MODEL-03).
mpv_version="$(cat "$SRC/mpv/MPV_VERSION" 2>/dev/null || sed -n 's/^\([0-9.]*\).*/\1/p' "$SRC/mpv/VERSION")"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Badger Player</string>
  <key>CFBundleExecutable</key><string>mpv</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>io.spacefleet.badger-desktop.player</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Badger Player</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${mpv_version}</string>
  <key>CFBundleVersion</key><string>${mpv_version}</string>
  <key>LSMinimumSystemVersion</key><string>${MACOS_MIN}</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
EOF
plutil -lint "$APP/Contents/Info.plist"
iconset="$WORK/icon.iconset"
rm -rf "$iconset" && mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$REPO/apps/badger/desktop/installer/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  half=$((size / 2))
  [ "$half" -ge 16 ] && cp "$iconset/icon_${size}x${size}.png" "$iconset/icon_${half}x${half}@2x.png"
done
iconutil -c icns "$iconset" -o "$APP/Contents/Resources/icon.icns"

# Ad-hoc signatures, inside out (packaging re-signs the whole app the same way).
for macho in "$OUT"/lib/*.dylib "$OUT"/bin/*; do codesign -s - --force "$macho"; done
codesign -s - --force "$APP"

# Hard guards: nothing outside the bundle / the OS, no symlinks (src/verify.ts re-checks all of this).
[ -z "$(find "$OUT/bin" "$OUT/lib" "$APP" -type l)" ] || { echo "bundle_contains_symlink" >&2; exit 1; }
for macho in "$OUT"/lib/*.dylib "$OUT"/bin/* "$APP/Contents/MacOS/mpv"; do
  [ "$(lipo -archs "$macho")" = "$MAC_ARCH" ] || { echo "wrong_arch: $macho $(lipo -archs "$macho")" >&2; exit 1; }
  while read -r dep; do
    case "$dep" in @rpath/*|/usr/lib/*|/System/*) ;; *) echo "foreign_link: $macho -> $dep" >&2; exit 1 ;; esac
  done < <(deps_of "$macho" | grep -v "^$(otool -D "$macho" | tail -n +2)\$" || true)
done
du -sh "$OUT/bin" "$OUT/lib" "$APP"
