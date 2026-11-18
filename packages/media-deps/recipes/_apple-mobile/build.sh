#!/bin/bash
# Apple mobile recipe (ios-arm64, tvos-arm64 and their -simulator twins): the embedded libmpv of the phone / TV apps
# from the shared mobile configuration (REL-DEPS-11), cross-built NATIVELY on an Apple Silicon Mac (no Docker) against
# the device or simulator SDK of APPLE_SDK.
#
#   recipes/<id>/build.sh <outdir>      (src/plan.ts runs it with every resolved build arg in the env)
#
# Output (`<outdir>`): one `<Name>.xcframework` per dynamic library, each with ONE slice
# `<platform>-arm64[-simulator]/<Name>.framework/{<Name>,Info.plist}`:
#   Libavutil Libavcodec Libavformat Libavfilter Libswresample Libswscale   FFmpeg (LGPL, decode/demux only)
#   Libmpv     (+ Headers/{client,render,render_gl,stream_cb}.h, Modules/module.modulemap)
#   MoltenVK   (Vulkan on Metal, mpv's vo=gpu-next renders through it)
# Every binary: release + thin LTO, stripped, minimum OS APPLE_MIN_OS, install name @rpath/<Name>.framework/<Name>,
# LC_RPATH @loader_path/.. (sibling frameworks inside the app's Frameworks/), links only the set, /usr/lib and
# /System. dav1d is static inside Libavcodec; libplacebo, shaderc, libass, freetype, harfbuzz and fribidi are
# static inside Libmpv. zlib and iconv are the copies the OS ships.
#
# Env (src/plan.ts): SRC_<ID>_URL / SRC_<ID>_SHA, FFMPEG_FLAGS, LIBPLACEBO_MESON_OPTIONS, MPV_MESON_OPTIONS,
# APPLE_SDK (iphoneos | appletvos | iphonesimulator | appletvsimulator), APPLE_MIN_OS, XCODE_VERSION, APPLE_SDK_VERSION,
# FORGE_AUTH (read by fetch-source).
# MEDIA_DEPS_WORK_DIR (optional): keep sources + build trees there and skip finished steps (local iteration).
set -euo pipefail

OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"
: "${APPLE_SDK:?}" "${APPLE_MIN_OS:?}" "${XCODE_VERSION:?}" "${APPLE_SDK_VERSION:?}"
: "${FFMPEG_FLAGS:?}" "${LIBPLACEBO_MESON_OPTIONS:?}" "${MPV_MESON_OPTIONS:?}"

ARCH=arm64
case "$APPLE_SDK" in
  iphoneos) MIN_FLAG=-miphoneos-version-min CMAKE_SYSTEM=iOS MESON_SUBSYSTEM=ios PLIST_PLATFORM=iPhoneOS ;;
  appletvos) MIN_FLAG=-mappletvos-version-min CMAKE_SYSTEM=tvOS MESON_SUBSYSTEM=tvos PLIST_PLATFORM=AppleTVOS ;;
  # Simulators: the same arm64 code against the simulator SDK (LC_BUILD_VERSION IOSSIMULATOR / TVOSSIMULATOR). CMake
  # picks the simulator min-version flag from the SDK path (CMAKE_OSX_SYSROOT).
  iphonesimulator) MIN_FLAG=-mios-simulator-version-min CMAKE_SYSTEM=iOS MESON_SUBSYSTEM=ios-simulator PLIST_PLATFORM=iPhoneSimulator ;;
  appletvsimulator) MIN_FLAG=-mtvos-simulator-version-min CMAKE_SYSTEM=tvOS MESON_SUBSYSTEM=tvos-simulator PLIST_PLATFORM=AppleTVSimulator ;;
  *) echo "apple-mobile recipe: unknown APPLE_SDK '$APPLE_SDK'" >&2; exit 1 ;;
esac

# ---- toolchain: the pinned Xcode / SDK (part of the recipe hash) --------------------------------------------
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
xcode="$(xcodebuild -version | sed -n 's/^Xcode //p')"
sdk_version="$(xcrun --sdk "$APPLE_SDK" --show-sdk-version)"
if [ "$xcode" != "$XCODE_VERSION" ] || [ "$sdk_version" != "$APPLE_SDK_VERSION" ]; then
  echo "apple-mobile recipe: needs Xcode $XCODE_VERSION / $APPLE_SDK SDK $APPLE_SDK_VERSION, found Xcode $xcode / SDK $sdk_version" >&2
  echo "(the Xcode/SDK pair is part of the published version: change recipes/<id>/target.ts to move it)" >&2
  exit 1
fi
# The device SDK goes to the compilers explicitly (-isysroot / cross file / CMAKE_OSX_SYSROOT), never through an
# exported SDKROOT: meson builds and runs BUILD-machine helpers (fribidi's table generators) with plain clang.
SDKROOT="$(xcrun --sdk "$APPLE_SDK" --show-sdk-path)"
unset MACOSX_DEPLOYMENT_TARGET

if [ -n "${MEDIA_DEPS_WORK_DIR:-}" ]; then
  WORK="$(mkdir -p "$MEDIA_DEPS_WORK_DIR" && cd "$MEDIA_DEPS_WORK_DIR" && pwd)"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/media-deps-$APPLE_SDK.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
fi
SRC="$WORK/src" PREFIX="$WORK/prefix" FF="$WORK/ff" MPV="$WORK/mpv"
mkdir -p "$SRC" "$PREFIX/lib/pkgconfig" "$WORK/stamps" "$WORK/tools"
JOBS="$(sysctl -n hw.ncpu)"

# Hermetic PATH: only the build tools below plus the OS. Nothing from Homebrew's lib/include/pkgconfig can leak in.
for tool in meson ninja cmake pkg-config autoreconf autoconf autoheader autom4te automake aclocal glibtoolize python3; do
  found="$(command -v "$tool" || true)"
  [ -n "$found" ] || { echo "apple-mobile recipe: build tool '$tool' missing (brew install meson ninja cmake pkgconf autoconf automake libtool)" >&2; exit 1; }
  ln -sf "$found" "$WORK/tools/$tool"
done
ln -sf "$WORK/tools/glibtoolize" "$WORK/tools/libtoolize"
export PATH="$WORK/tools:/usr/bin:/bin:/usr/sbin:/sbin"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$FF/lib/pkgconfig" PKG_CONFIG_PATH=""
export GIT_CEILING_DIRECTORIES="$WORK"

ARCH_FLAGS="-arch $ARCH $MIN_FLAG=$APPLE_MIN_OS -isysroot $SDKROOT"
OPT_FLAGS="-O2 -flto=thin"
# Compiler + flags for the autotools step only: meson reads its flags from the cross file and would apply
# exported CFLAGS to the BUILD machine (its native helpers, e.g. fribidi's table generators), CMake from CMAKE_*.
AUTOCONF_ENV=(CC=clang CXX=clang++ "CFLAGS=$ARCH_FLAGS $OPT_FLAGS -I$PREFIX/include" "CXXFLAGS=$ARCH_FLAGS $OPT_FLAGS -I$PREFIX/include"
  "LDFLAGS=$ARCH_FLAGS -flto=thin -L$PREFIX/lib -Wl,-dead_strip")
# Autotools: a cross build (host = the device, build = this Mac; the device binaries cannot run here).
AUTOCONF_CROSS=(--host=aarch64-apple-ios --build=aarch64-apple-darwin)

# meson cross file: the device is another machine, its test programs never run here.
quote_list() { local out="" item; for item in "$@"; do out="$out'$item', "; done; printf '[%s]' "${out%, }"; }
# shellcheck disable=SC2086
{
  echo "[binaries]"
  echo "c = 'clang'"; echo "cpp = 'clang++'"; echo "objc = 'clang'"; echo "objcpp = 'clang++'"
  echo "ar = 'ar'"; echo "strip = 'strip'"; echo "pkg-config = 'pkg-config'"
  echo "[built-in options]"
  for lang in c cpp objc objcpp; do
    echo "${lang}_args = $(quote_list $ARCH_FLAGS -I$PREFIX/include)"
    echo "${lang}_link_args = $(quote_list $ARCH_FLAGS -L$PREFIX/lib -Wl,-dead_strip)"
  done
  echo "[properties]"
  echo "needs_exe_wrapper = true"
  echo "pkg_config_libdir = '$PKG_CONFIG_LIBDIR'"
  echo "[host_machine]"
  echo "system = 'darwin'"; echo "subsystem = '$MESON_SUBSYSTEM'"; echo "kernel = 'xnu'"
  echo "cpu_family = 'aarch64'"; echo "cpu = 'arm64'"; echo "endian = 'little'"
} > "$WORK/meson-cross.ini"
MESON=(--prefix="$PREFIX" --libdir=lib --buildtype=release -Db_ndebug=true -Db_lto=true -Db_lto_mode=thin --cross-file "$WORK/meson-cross.ini")
CMAKE=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_LIBDIR=lib
  -DCMAKE_SYSTEM_NAME="$CMAKE_SYSTEM" -DCMAKE_OSX_SYSROOT="$SDKROOT" -DCMAKE_OSX_ARCHITECTURES="$ARCH"
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$APPLE_MIN_OS"
  -DCMAKE_INTERPROCEDURAL_OPTIMIZATION=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5
  -DCMAKE_PREFIX_PATH="$PREFIX" -DCMAKE_FIND_ROOT_PATH="$PREFIX" -DCMAKE_IGNORE_PREFIX_PATH="/opt/homebrew;/usr/local"
  -DCMAKE_FIND_FRAMEWORK=LAST)

fetch-source() { sh "$PKG/recipes/_shared/fetch-source.sh" "$@"; }
# step <name>: false when the step already finished in a kept MEDIA_DEPS_WORK_DIR.
step() { if [ -e "$WORK/stamps/$1" ]; then echo "[apple-mobile] skip $1 (done)"; return 1; fi; echo "[apple-mobile] ---- $1"; rm -rf "${SRC:?}/$1"; }
done_step() { touch "$WORK/stamps/$1"; }

# ---- dav1d (static, inside libavcodec) ---------------------------------------------------------------------------
if step dav1d; then
  fetch-source dav1d "$SRC_DAV1D_URL" "$SRC_DAV1D_SHA" "$SRC/dav1d"
  meson setup "$SRC/dav1d/build" "$SRC/dav1d" "${MESON[@]}" --default-library=static \
    -Denable_tools=false -Denable_tests=false -Denable_examples=false
  meson compile -C "$SRC/dav1d/build"
  meson install -C "$SRC/dav1d/build"
  done_step dav1d
fi

# ---- FFmpeg: shared libraries, decode/demux only, LGPL --------------------------------------------------------
if step ffmpeg; then
  # `ffmpegmobile`: the 8.1.3 release tree + our HLS seek patch (src/sources.ts).
  fetch-source ffmpegmobile "$SRC_FFMPEGMOBILE_URL" "$SRC_FFMPEGMOBILE_SHA" "$SRC/ffmpeg"
  # -headerpad_max_install_names: the assemble step rewrites every `@rpath/libavutil.60.dylib` into the longer
  # `@rpath/Libavutil.framework/Libavutil`; without room in the header install_name_tool refuses (it did for
  # Libavformat in the simulator build). CMake (MoltenVK) and meson (mpv) already pad.
  # shellcheck disable=SC2086
  (cd "$SRC/ffmpeg" && ./configure --prefix="$FF" --enable-shared --disable-static --enable-pic --enable-lto=thin \
     --install-name-dir=@rpath --pkg-config=pkg-config --pkg-config-flags=--static \
     --cc=clang --cxx=clang++ --objcc=clang --sysroot="$SDKROOT" \
     --extra-cflags="$ARCH_FLAGS -I$PREFIX/include" --extra-objcflags="$ARCH_FLAGS" \
     --extra-ldflags="$ARCH_FLAGS -L$PREFIX/lib -Wl,-dead_strip -Wl,-headerpad_max_install_names" \
     $FFMPEG_FLAGS \
   && make -j"$JOBS" && make install)
  # mpv links the dylibs: their private (static) dependencies must not leak into its link line.
  sed -i '' -e '/^Libs\.private:/d' -e '/^Requires\.private:/d' "$FF"/lib/pkgconfig/*.pc
  done_step ffmpeg
fi

# ---- mpv's own dependencies: static libraries --------------------------------------------------------------------
if step freetype; then
  fetch-source freetype "$SRC_FREETYPE_URL" "$SRC_FREETYPE_SHA" "$SRC/freetype"
  meson setup "$SRC/freetype/build" "$SRC/freetype" "${MESON[@]}" --default-library=static \
    -Dzlib=system -Dbzip2=disabled -Dpng=disabled -Dharfbuzz=disabled -Dbrotli=disabled -Dmmap=enabled -Dtests=disabled
  meson compile -C "$SRC/freetype/build"
  meson install -C "$SRC/freetype/build"
  done_step freetype
fi

if step harfbuzz; then
  fetch-source harfbuzz "$SRC_HARFBUZZ_URL" "$SRC_HARFBUZZ_SHA" "$SRC/harfbuzz"
  meson setup "$SRC/harfbuzz/build" "$SRC/harfbuzz" "${MESON[@]}" --default-library=static \
    -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled -Dcoretext=disabled \
    -Dchafa=disabled -Dgraphite2=disabled -Dtests=disabled -Ddocs=disabled -Dbenchmark=disabled -Dutilities=disabled \
    -Dintrospection=disabled
  meson compile -C "$SRC/harfbuzz/build"
  meson install -C "$SRC/harfbuzz/build"
  done_step harfbuzz
fi

if step fribidi; then
  fetch-source fribidi "$SRC_FRIBIDI_URL" "$SRC_FRIBIDI_SHA" "$SRC/fribidi"
  meson setup "$SRC/fribidi/build" "$SRC/fribidi" "${MESON[@]}" --default-library=static -Dtests=false -Ddocs=false -Dbin=false
  meson compile -C "$SRC/fribidi/build"
  meson install -C "$SRC/fribidi/build"
  done_step fribidi
fi

# libass finds the system fonts through CoreText: no fontconfig, no font files shipped. Its aarch64 assembly gets
# the Mach-O leading underscore (-DPREFIX) only for *darwin* hosts, so the ios / tvos host passes it itself.
if step libass; then
  fetch-source libass "$SRC_LIBASS_URL" "$SRC_LIBASS_SHA" "$SRC/libass"
  # The fork carries libass's generated autotools files, and a git checkout gives them arbitrary mtimes: make may then
  # see aclocal.m4 as older than configure.ac / m4/*.m4 and call aclocal-1.17, which the runner does not have. Stamp
  # them in dependency order (aclocal.m4, then configure, then Makefile.in / config.h.in) so make never regenerates.
  (cd "$SRC/libass" && touch aclocal.m4 && touch configure && find . \( -name Makefile.in -o -name config.h.in \) -exec touch {} +)
  (cd "$SRC/libass" && env "${AUTOCONF_ENV[@]}" "CCASFLAGS=$ARCH_FLAGS -DPREFIX" ./configure --prefix="$PREFIX" "${AUTOCONF_CROSS[@]}" --enable-static --disable-shared \
     --disable-fontconfig --enable-coretext --disable-libunibreak --disable-require-system-font-provider \
   && make -j"$JOBS" && make install)
  done_step libass
fi

# ---- Vulkan on Metal: MoltenVK (dynamic framework) + the GLSL compiler libplacebo needs (shaderc, static) -------
if step vulkanheaders; then
  fetch-source vulkanheaders "$SRC_VULKANHEADERS_URL" "$SRC_VULKANHEADERS_SHA" "$SRC/vulkanheaders"
  cmake -S "$SRC/vulkanheaders" -B "$SRC/vulkanheaders/build" "${CMAKE[@]}" -DVULKAN_HEADERS_ENABLE_MODULE=OFF -DVULKAN_HEADERS_ENABLE_TESTS=OFF
  cmake --install "$SRC/vulkanheaders/build"
  done_step vulkanheaders
fi

# MoltenVK pulls its dependencies through CPM (network); the macOS recipe's CPM stand-in maps each to its pinned
# fork tree. cereal is required (pipeline caches: without it libplacebo cannot create a render pass).
if step moltenvk; then
  rm -rf "$SRC/moltenvk-spirv-cross" "$SRC/cereal"
  fetch-source moltenvk "$SRC_MOLTENVK_URL" "$SRC_MOLTENVK_SHA" "$SRC/moltenvk"
  fetch-source moltenvkspirvcross "$SRC_MOLTENVKSPIRVCROSS_URL" "$SRC_MOLTENVKSPIRVCROSS_SHA" "$SRC/moltenvk-spirv-cross"
  fetch-source cereal "$SRC_CEREAL_URL" "$SRC_CEREAL_SHA" "$SRC/cereal"
  cpm_version="$(sed -n 's/^set(CPM_DOWNLOAD_VERSION \(.*\))$/\1/p' "$SRC/moltenvk/cmake/recipes/CPM.cmake")"
  mkdir -p "$WORK/cpm/cpm"
  cp "$PKG/recipes/_macos/cpm.cmake" "$WORK/cpm/cpm/CPM_${cpm_version}.cmake"
  # MoltenVK's CMake hard-requires AppKit, which device SDKs lack: its sources import UIKit there instead, and the
  # CoreGraphics colour spaces AppKit pulls in on macOS must be linked explicitly. It also requires IOKit, which only
  # MoltenVK's macOS code uses (MVKDevice.mm, `#if MVK_MACOS`): the tvOS SDK has none, so Foundation stands in there.
  mvk_iokit=()
  [ -d "$SDKROOT/System/Library/Frameworks/IOKit.framework" ] || mvk_iokit=(-DIOKIT_LIBRARY="$SDKROOT/System/Library/Frameworks/Foundation.framework")
  cmake -S "$SRC/moltenvk" -B "$SRC/moltenvk/build" "${CMAKE[@]}" -DCPM_SOURCE_CACHE="$WORK/cpm" \
    -DSF_SOURCE_SPIRV-Cross="$SRC/moltenvk-spirv-cross" -DSF_SOURCE_Vulkan-Headers="$SRC/vulkanheaders" \
    -DSF_SOURCE_cereal="$SRC/cereal" \
    -DMVK_EXCLUDE_SPIRV_TOOLS=ON -DMVK_BUILD_SHADER_CONVERTER_TOOL=OFF \
    -DMOLTEN_VK_WITH_CCACHE=OFF -DMVK_CONFIG_LOG_LEVEL=warn ${mvk_iokit[@]+"${mvk_iokit[@]}"} \
    -DAPPKIT_LIBRARY="$SDKROOT/System/Library/Frameworks/UIKit.framework;$SDKROOT/System/Library/Frameworks/CoreGraphics.framework"
  cmake --build "$SRC/moltenvk/build"
  cmake --install "$SRC/moltenvk/build"
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
  cmake --build "$SRC/shaderc/build"
  cmake --install "$SRC/shaderc/build"
  # One static archive (shaderc + glslang + SPIRV-Tools) linked into libmpv; never the dylib.
  rm -f "$PREFIX"/lib/libshaderc_shared*.dylib
  cp "$PREFIX/lib/pkgconfig/shaderc_combined.pc" "$PREFIX/lib/pkgconfig/shaderc.pc"
  done_step shaderc
fi

# ---- libplacebo + libmpv -----------------------------------------------------------------------------------------
if step libplacebo; then
  fetch-source --submodules libplacebo "$SRC_LIBPLACEBO_URL" "$SRC_LIBPLACEBO_SHA" "$SRC/libplacebo"
  # shellcheck disable=SC2086
  meson setup "$SRC/libplacebo/build" "$SRC/libplacebo" "${MESON[@]}" --default-library=static $LIBPLACEBO_MESON_OPTIONS
  meson compile -C "$SRC/libplacebo/build"
  meson install -C "$SRC/libplacebo/build"
  done_step libplacebo
fi

if step mpv; then
  # `mpvmobile`: mpv v0.41.0 + our moltenvk gpu context (src/sources.ts).
  fetch-source mpvmobile "$SRC_MPVMOBILE_URL" "$SRC_MPVMOBILE_SHA" "$SRC/mpv"
  # mpv enables Objective-C (ao_audiounit, hwdec_vt_pl, the moltenvk context) only once its SDK probe answers;
  # the probe asks for the macOS SDK unless told which one to use.
  # mpv defaults to b_lundef=false (-undefined dynamic_lookup): an unresolved symbol would link and only fail in
  # dyld on the device. b_lundef=true makes it a link error; the static C++ (shaderc, libplacebo) and the
  # frameworks ao_audiounit (AVAudioSession) and hwdec_vt_pl (MTLCreateSystemDefaultDevice) use are linked here.
  mpv_link_args="$(quote_list $ARCH_FLAGS -L$PREFIX/lib -Wl,-dead_strip -lc++ -framework AVFoundation -framework Metal)"
  # shellcheck disable=SC2086
  MACOS_SDK="$SDKROOT" MACOS_SDK_VERSION="$APPLE_SDK_VERSION" \
    meson setup "$SRC/mpv/build" "$SRC/mpv" "${MESON[@]}" --prefix="$MPV" --default-library=shared -Db_lundef=true \
    -Dc_link_args="$mpv_link_args" -Dobjc_link_args="$mpv_link_args" -Dcpp_link_args="$mpv_link_args" $MPV_MESON_OPTIONS
  meson compile -C "$SRC/mpv/build"
  meson install -C "$SRC/mpv/build"
  done_step mpv
fi

# ---- assemble: one framework per dylib, each wrapped as an xcframework -------------------------------------------
deps_of() { otool -L "$1" | tail -n +2 | awk '{print $1}'; }
rpaths_of() { otool -l "$1" | awk '/cmd LC_RPATH/{getline; getline; print $2}'; }
pc_version() { sed -n 's/^Version: *//p' "$1"; }

# name -> built dylib + the version its Info.plist carries
FRAMEWORKS=(Libavutil Libavcodec Libavformat Libavfilter Libswresample Libswscale Libmpv MoltenVK)
dylib_of() {
  case "$1" in
    Libmpv) echo "$MPV/lib/libmpv.dylib" ;;
    MoltenVK) echo "$PREFIX/lib/libMoltenVK.dylib" ;;
    Lib*) local lib; lib="$(echo "$1" | tr '[:upper:]' '[:lower:]')"; echo "$FF/lib/$lib.dylib" ;;
  esac
}
version_of() {
  case "$1" in
    Libmpv) pc_version "$MPV/lib/pkgconfig/mpv.pc" ;;
    MoltenVK) pc_version "$PREFIX/lib/pkgconfig/MoltenVK.pc" ;;
    Lib*) pc_version "$FF/lib/pkgconfig/$(echo "$1" | tr '[:upper:]' '[:lower:]').pc" ;;
  esac
}
# A dependency's install name (`@rpath/libavutil.60.dylib`, `@rpath/libMoltenVK.dylib`) -> its framework name.
framework_of_dep() {
  local base; base="$(basename "$1")"
  for name in "${FRAMEWORKS[@]}"; do
    local stem; stem="$(basename "$(dylib_of "$name")" .dylib)"
    case "$base" in "$stem.dylib"|"$stem".*.dylib) echo "$name"; return 0 ;; esac
  done
  return 1
}

STAGE="$WORK/frameworks"
rm -rf "$STAGE" && mkdir -p "$STAGE"
for name in "${FRAMEWORKS[@]}"; do
  fw="$STAGE/$name.framework"
  mkdir -p "$fw"
  cp -L "$(dylib_of "$name")" "$fw/$name"
  chmod 755 "$fw/$name"
  bin="$fw/$name"
  install_name_tool -id "@rpath/$name.framework/$name" "$bin"
  while read -r dep; do
    [ -n "$dep" ] || continue
    case "$dep" in /usr/lib/*|/System/*|"@rpath/$name.framework/$name") continue ;; esac
    dep_name="$(framework_of_dep "$dep")" || { echo "assemble: $name links $dep (not in the framework set, not the OS)" >&2; exit 1; }
    install_name_tool -change "$dep" "@rpath/$dep_name.framework/$dep_name" "$bin"
  done < <(deps_of "$bin")
  while read -r rp; do [ -n "$rp" ] && install_name_tool -delete_rpath "$rp" "$bin"; done < <(rpaths_of "$bin")
  install_name_tool -add_rpath @loader_path/.. "$bin"
  strip -x -S "$bin"
  version="$(version_of "$name")"
  cat > "$fw/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>io.spacefleet.deps.$(echo "$name" | tr '[:upper:]' '[:lower:]')</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleSupportedPlatforms</key><array><string>$PLIST_PLATFORM</string></array>
  <key>MinimumOSVersion</key><string>$APPLE_MIN_OS</string>
</dict>
</plist>
EOF
  plutil -lint "$fw/Info.plist"
done

# libmpv's C API as the framework's public headers + a clang module (`import Libmpv` in Swift).
mkdir -p "$STAGE/Libmpv.framework/Headers" "$STAGE/Libmpv.framework/Modules"
cp "$MPV"/include/mpv/{client.h,render.h,render_gl.h,stream_cb.h} "$STAGE/Libmpv.framework/Headers/"
cat > "$STAGE/Libmpv.framework/Modules/module.modulemap" <<'EOF'
framework module Libmpv {
    header "client.h"
    header "render.h"
    header "render_gl.h"
    header "stream_cb.h"
    export *
}
EOF

# Ad-hoc signatures (install_name_tool / strip invalidated the linker's); the app re-signs when embedding.
for name in "${FRAMEWORKS[@]}"; do codesign -s - --force "$STAGE/$name.framework/$name"; done

rm -rf "$OUT"/*.xcframework
for name in "${FRAMEWORKS[@]}"; do
  xcodebuild -create-xcframework -framework "$STAGE/$name.framework" -output "$OUT/$name.xcframework"
done

# Hard guards (src/verifyMobile.ts re-checks all of this): device arm64 only, nothing outside the set / the OS.
[ -z "$(find "$OUT" -type l)" ] || { echo "bundle_contains_symlink" >&2; exit 1; }
for name in "${FRAMEWORKS[@]}"; do
  bin="$(find "$OUT/$name.xcframework" -path "*/$name.framework/$name" -type f)"
  [ "$(lipo -archs "$bin")" = "$ARCH" ] || { echo "wrong_arch: $bin $(lipo -archs "$bin")" >&2; exit 1; }
  while read -r dep; do
    case "$dep" in @rpath/*.framework/*|/usr/lib/*|/System/*) ;; *) echo "foreign_link: $bin -> $dep" >&2; exit 1 ;; esac
  done < <(deps_of "$bin")
  flat="$(nm -m -u "$bin" | grep -c '(dynamically looked up)' || true)"
  [ "$flat" = 0 ] || { echo "flat_lookup: $bin has $flat unbound imports (nm -m -u)" >&2; exit 1; }
done
du -sh "$OUT"/*.xcframework
