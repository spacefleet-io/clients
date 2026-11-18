# Build recipes

One directory per OS target, `recipes/<os>-<arch>/`, auto-discovered by `src/targets.ts`
(nothing else lists targets). Directories starting with `_` are shared code, not targets: `_shared/` holds
scripts every recipe reuses (hash-checked source fetch), `_macos/` the one build both macOS recipes run,
`_apple-mobile/` the one build of the iPhone and Apple TV recipes, `_android/` the one build of both Android recipes.

A recipe contains:

- `target.ts` — default-exports a `DepsTarget` (`src/target.ts`): id, `builder` (`docker` | `native`), pinned
  `sources`, extra ffmpeg flags / hardware families / hwaccels, libplacebo + mpv meson options, extra
  required mpv features, the GPU path `verify` asserts (`mpvRequiredHwdecs`, `mpvRequiredGpuContexts`,
  `ffmpegRequiredHwaccelMethods`), the libraries left to the host (`hostLibraries`, Linux), IPC kind; optionally
  `recipeInputs` (files outside the recipe directory it reads: hashed into the version and shipped in the source
  archive) and `layout` (where mpv and the libraries sit).
- the build: a `Dockerfile` whose `out` stage (`FROM scratch`) holds the bundle root (`/bin`), OR (native) a
  `build.sh <outdir>` that writes the bundle root on a runner of that OS. `scripts/build.ts` runs it with every
  resolved build arg (`SRC_*_URL` = the fork's clone url, `SRC_*_SHA` = the pinned commit, `FFMPEG_FLAGS`,
  `MPV_MESON_OPTIONS`, …) and, when a token is set, the `FORGE_AUTH` credential (read by `fetch-source.sh` itself) in the environment.

Contract of the output: `bin/{ffmpeg,ffprobe}` (+ `.exe`) and mpv with every library they need inside the bundle,
nothing resolved from the host except OS system libraries — on Linux exactly the `hostLibraries` globs (glibc and
the graphics stack a host GPU driver shares with mpv; README "Host requirements"). Linux and Windows: everything
flat in `bin/`.

## macOS (`macos-arm64`, `macos-x64`)

Both `target.ts` call `_macos/macosTarget.ts`; both `build.sh` exec `_macos/build.sh` (`MAC_ARCH` comes from the
target's build args). It runs natively on an Apple Silicon Mac (host mode, no Docker):

- Toolchain: the Xcode / macOS SDK pinned in `macosTarget.ts` (`XCODE_VERSION`, `MACOS_SDK_VERSION`: part of the
  published version; the script refuses another one), `MACOSX_DEPLOYMENT_TARGET=14.0`. Build tools (meson, ninja,
  cmake, nasm, pkg-config, autotools) come from Homebrew through a hermetic `PATH` of symlinks; `pkg-config` sees
  only the build prefix and CMake ignores `/opt/homebrew`, so no Homebrew library can be linked (REL-DEPS-09).
- `macos-x64` is a cross build on the same host (`-arch x86_64`, meson cross file, `--host=x86_64-apple-darwin`);
  configure checks and LuaJIT's `buildvm` run under Rosetta 2. Never a universal binary.
- Release + thin LTO + `-dead_strip`, stripped, every library feature-trimmed (REL-DEPS-10). Two libraries are
  built without LTO: LuaJIT (its VM is generated assembly) and x264 (clang miscompiles its macroblock-cache
  preallocation under LTO: every libx264 encode segfaults).
- MoltenVK builds with its own CMake build; `_macos/cpm.cmake` stands in for CPM.cmake so its dependencies
  (SPIRV-Cross, Vulkan-Headers, cereal) come from the pinned forks, never the network. cereal is required: without
  it MoltenVK cannot create pipeline caches and libplacebo draws no frame.
- GPU path `verify` asserts: `mpvRequiredHwdecs` `["videotoolbox", "videotoolbox-copy"]`,
  `ffmpegRequiredHwaccelMethods` `["videotoolbox"]`, `mpvRequiredGpuContexts` `["macvk"]` (Vulkan on Metal).
- Output: `bin/{ffmpeg,ffprobe,sf-lifeline}`, `lib/*.dylib`, `Badger Player.app/` (mpv); install names,
  rpaths and ad-hoc signatures as described in [../README.md](../README.md#layout-of-a-bundle). `verify` checks all
  of it on the Mac (x64 under Rosetta 2).
- Local iteration: `MEDIA_DEPS_WORK_DIR=<dir>` keeps sources and build trees and skips finished libraries.

The macOS-only pins (MoltenVK, its SPIRV-Cross, Vulkan-Headers and cereal revisions, x265 4.2) live in `src/sources.ts`
like every other pin, not in `extraSources`: `scripts/forks.ts` (create, nightly sync, `check`) only walks
`SOURCES`, so a pin outside it would never be mirrored or checked.

## Android (`android-arm64`, `android-arm`, `android-x64`, `android-ia32`)

The phone/TV libmpv (REL-DEPS-11): a MOBILE target, built from the shared `MOBILE_FEATURES` (playback only, no
encoder, no GPL, no TLS), one bundle per Android ABI (PLAT-TV-05: arm64-v8a, armeabi-v7a, x86_64, x86). Every
`target.ts` calls `_android/androidTarget.ts` (its `ABIS` table: NDK triple, meson CPU family, ffmpeg `--arch`/`--cpu`;
armeabi-v7a with NEON, x86 with ffmpeg's assembly off because it needs text relocations Android refuses); the four `Dockerfile`s are identical
(a test enforces it) and run `_android/steps/<step>.sh` one stage per step (`toolchain`, `libs`, `ffmpeg`, `mpv`,
`player`, `assemble`; shared variables in `_android/env.sh`), so editing one step rebuilds from its own stage.

- Toolchain: Android NDK r27b (27.1.12297006, the NDK React Native builds with), downloaded from Google by the
  target's pinned `NDK_URL` + `NDK_SHA256` build args and refused unless the hash and `Pkg.Revision` match: a compiler,
  like the base image and apt packages; every library still comes from a fork. API level 26 (= minSdk; no bionic
  iconv). Meson cross file; pkg-config sees only the build prefix.
- Static, PIC: dav1d (into libavcodec), freetype, harfbuzz, fribidi, expat, fontconfig, libass, libplacebo (into
  libmpv). libass finds fonts through fontconfig: Android has no font API it can use; the app writes `fonts.conf` and
  sets `FONTCONFIG_FILE` (`mobile-mpv-playback` `MpvFontConfig.kt`).
- Shared: the six ffmpeg libraries (MediaCodec decoders via `--enable-jni --enable-mediacodec`), `libmpv.so` (GL/EGL on
  the app's Surface, `android-media-ndk` hwdec, OpenSL ES + AAudio + AudioTrack), `libplayer.so` (the JNI bridge
  `is.xyz.mpv.MPVLib` loads, compiled from `_android/jni/`: mpv-android `app/src/main/jni` at commit
  `e9e9326f12ab5f0f46a18e005f4d7fb21f97229e`, MIT, `_android/jni/LICENSE`) and the NDK's `libc++_shared.so`.
- Output: `lib/<abi>/*.so` (the jniLibs tree `packages/mobile-mpv-playback/android` packages from
  `vendor/deps/android-<arch>/lib`): unversioned sonames (Android loads by file name), stripped, 16 KiB LOAD alignment, no text relocations.
  `verify` checks that with `readelf` plus the strings ffmpeg and mpv embed (LGPL, configure line, mpv features);
  nothing runs on the build host. Shipping still needs the media format test set played on a real device.

## iPhone and Apple TV (`ios-arm64`, `tvos-arm64`, and their `-simulator` twins)

The phone/TV libmpv (REL-DEPS-11) for Apple devices: a MOBILE target from the shared `MOBILE_FEATURES`. Both
`target.ts` call `_apple-mobile/appleMobileTarget.ts` and differ only in the device SDK (`APPLE_SDK` `iphoneos` |
`appletvos`, minimum OS 15.1 = the React Native / react-native-tvos 0.85 floor), so the Apple TV plays through the
iPhone's libmpv (MPV-TV-01); both `build.sh` exec `_apple-mobile/build.sh` natively on the Apple Silicon runner.

- Toolchain: the Xcode / SDK pair pinned in `appleMobileTarget.ts` (`XCODE_VERSION`, `APPLE_SDK_VERSION`).
- MoltenVK (dynamic) + shaderc, libplacebo, libass (CoreText), freetype, harfbuzz, fribidi (static, inside Libmpv);
  dav1d inside Libavcodec. MoltenVK's CMake asks for AppKit and IOKit, which device SDKs lack (tvOS has no IOKit at
  all): UIKit + CoreGraphics stand in for AppKit and Foundation for IOKit, which only MoltenVK's macOS code uses.
- Output: one `<Name>.xcframework` per dynamic library with a single slice named like the target
  (`<ios|tvos>-arm64` device, `<ios|tvos>-arm64-simulator` simulator). `verify` reads the Mach-O load commands
  (platform IOS / TVOS / IOSSIMULATOR / TVOSSIMULATOR, minimum OS, install names, rpaths, links, stripped) plus the
  strings ffmpeg and mpv embed; nothing runs on the build host.
- Simulators (`ios-arm64-simulator`, `tvos-arm64-simulator`; `APPLE_SDK` `iphonesimulator` | `appletvsimulator`): the
  same recipe and configuration for the Apple Silicon Xcode simulators, where the iPhone app is tested on iOS versions
  older than the test iPhone (REL-MOB-02) and the Apple TV app is tested (REL-TV-03). Each is a bundle of its own,
  never a second slice in the device bundle: the device download stays the same size, the two
  build in parallel, and a failing simulator build never blocks a device release. `packages/mobile-mpv-playback/scripts/fetch-ios-deps.ts` joins the device and simulator
  slices into one xcframework per library on the developer's machine, so Xcode picks the slice per destination and a
  device build embeds only the device slice.
