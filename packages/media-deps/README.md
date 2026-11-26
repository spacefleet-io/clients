# @space/media-deps

Our own reduced builds of **ffmpeg + ffprobe + mpv** for every desktop OS, from ONE shared kept-features
list. They replace the BtbN ffmpeg download, the `cpu-min` / `playback-shared-min` profiles and the mpv
`linux-bundle` / AppImage flows (`packages/ffmpeg` and `packages/mpv` no longer build anything).

| Target | Builder | Hardware encoders | mpv GPU render / hardware decode | mpv IPC |
| --- | --- | --- | --- | --- |
| `linux-x64` | docker, Ubuntu 22.04 (glibc 2.35) | VA-API, NVENC, QSV, AMF | OpenGL on EGL/X11 (`x11egl`) / VA-API, NVDEC | unix socket |
| `windows-x64` | docker, mingw-w64 UCRT cross build | QSV, AMF, NVENC | D3D11 (`d3d11`, WARP = CPU fallback) / D3D11VA, DXVA2, NVDEC | named pipe |
| `macos-arm64` | native, Apple Silicon Mac (Xcode 26.4, macOS 14.0+) | VideoToolbox | Vulkan on Metal (`macvk`, MoltenVK) / VideoToolbox | unix socket |
| `macos-x64` | native, same Mac, `-arch x86_64` cross build (macOS 14.0+, runs under Rosetta 2) | VideoToolbox | Vulkan on Metal (`macvk`, MoltenVK) / VideoToolbox | unix socket |

Phones and TVs embed a libmpv library instead (MOBILE targets, REL-DEPS-11): one shared playback-only, LGPL, no-encoder
configuration (`MOBILE_FEATURES`), no ffmpeg/ffprobe programs.

| Target | Builder | Output | mpv GPU render / hardware decode / audio |
| --- | --- | --- | --- |
| `android-arm64` | docker, NDK r27b cross build (API 26) | `lib/arm64-v8a/*.so` (jniLibs of `packages/mobile-mpv-playback`) | OpenGL ES on EGL (`android`) / MediaCodec / OpenSL ES, AAudio, AudioTrack |
| `android-arm` | same, 32-bit ARMv7 + NEON (many Android TV boxes) | `lib/armeabi-v7a/*.so` | same |
| `android-x64` | same, emulator / x86 devices | `lib/x86_64/*.so` | same |
| `android-ia32` | same, 32-bit x86 (ffmpeg without assembly: Android refuses text relocations) | `lib/x86/*.so` | same |

The app picks the GPU path on Linux (`--vo=gpu,wlshm` in a Wayland session, `--vo=gpu,x11` in an X11 one, both
with `--hwdec=auto-safe`; `--vo=gpu --hwdec=auto-safe` on Windows) and falls back to the CPU by itself (#25).
Linux mpv is native on both display servers (MPV-GPU-04): `wayland` and `x11egl` GPU contexts, `wlshm` /
`dmabuf-wayland` / `x11` outputs. mpv 0.41's Wayland needs wayland ≥ 1.21 / wayland-protocols ≥ 1.31 where the
jammy builder has 1.20 / 1.25, so both are built from their pinned forks. Linux has no Vulkan and no DRM/KMS
output: `egl-drm` / `vaapi-drm` / mpv's `drm` need libdisplay-info (no fork).

The phone and TV apps embed **libmpv** from a second, shared mobile configuration (`MOBILE_FEATURES` in
`src/features.ts`, REL-DEPS-11): the desktop list's demuxers, parsers and decoders, playback only, no encoder,
no muxer, no ffmpeg/ffprobe/mpv program, no GPL part (the whole set is LGPL), release + thin LTO, stripped. A
mobile recipe adds only its platform's hardware decoding, audio output and video output (`MobileDepsTarget`).

| Mobile target | Builder | Output | mpv video / audio / hardware decode |
| --- | --- | --- | --- |
| `ios-arm64` | native, Apple Silicon Mac (Xcode 26.4, iPhoneOS SDK 26.4, iOS 15.1+, devices only) | dynamic `.xcframework`s | `vo=gpu-next` on Vulkan/MoltenVK into the app's `CAMetalLayer` (`gpu-context=moltenvk`, layer passed as `--wid`) / `ao=audiounit` / VideoToolbox |
| `tvos-arm64` | same recipe (`recipes/_apple-mobile`), AppleTVOS SDK 26.4, tvOS 15.1+ (react-native-tvos 0.85's floor; covers Apple TV HD), devices only | same `.xcframework`s, `tvos-arm64` slice | same as `ios-arm64` (MPV-TV-01: the Apple TV plays through the iPhone's libmpv) |
| `ios-arm64-simulator`, `tvos-arm64-simulator` | same recipe, iPhoneSimulator / AppleTVSimulator SDK 26.4, iOS / tvOS 15.1+, Apple Silicon Xcode simulators only | same `.xcframework`s, `<ios\|tvos>-arm64-simulator` slice, a bundle of its own | same as the device (REL-MOB-02, REL-TV-03: the older-iOS and Apple TV tests run on simulators); `fetch-ios-deps.ts` joins it with the device slice |

## Layout of a bundle

```
vendor/deps/<target>/            (dev checkout)   |   <resources>/deps/   (packaged)
  bin/ffmpeg ffprobe mpv (+ .exe) + every DLL / shared lib they need, FLAT      (linux, windows)
  bin/ffmpeg ffprobe sf-lifeline, lib/*.dylib, Badger Player.app/               (macos)
  <Name>.xcframework/<ios|tvos>-arm64/<Name>.framework/<Name>                   (ios, tvos: Libavutil Libavcodec
                                 Libavformat Libavfilter Libswresample Libswscale Libmpv MoltenVK)
  deps-manifest.json             versions, recipe hash, sha256 + size of every file (paths relative to the bundle)
```

Linux libraries carry `RUNPATH=$ORIGIN` (no `LD_LIBRARY_PATH`), no symlinks. Windows DLLs sit next to the
executables and are ffmpeg's own only: the shader compilers (shaderc, SPIRV-Cross) and the mingw runtime
(libstdc++, libgcc, winpthread) are linked statically, and `verify` fails on any other DLL. `mpv.exe` is a
console-subsystem build: spawn it with `windowsHide`. It is built as "Badger Player" with Badger's icon
(`recipes/windows-x64/brand-mpv.sh`, MPV-MODEL-05), so its window and taskbar button show Badger, not mpv.

iOS frameworks have the install name `@rpath/<Name>.framework/<Name>`, `LC_RPATH @loader_path/..`, link only
each other, `/usr/lib` and `/System`, and are ad-hoc signed (the app re-signs them when embedding). dav1d is
static inside Libavcodec; libplacebo, shaderc, libass, freetype, harfbuzz and fribidi are static inside Libmpv.
`Libmpv.framework` carries libmpv's C headers and a module map (`import Libmpv`). The app keeps the
`CAMetalLayer` alive while mpv draws into it and sets its `contentsScale`. `verify` on a mobile target is
static (the binaries cannot run on the host): Mach-O arch, minimum OS, install names and links, no debug
symbols, then the embedded licence (`LGPL`), configure line (no `--enable-gpl`, encoders, muxers or programs)
and mpv feature list read out of the binaries' bytes.

### Host requirements (Linux)

The bundle NEVER carries the host's C runtime or graphics stack (`hostLibraries` in
`recipes/linux-x64/target.ts`): glibc, GL/GLX/EGL (libglvnd), libdrm, gbm, Vulkan, Wayland, X11/xcb, and the
runtime a GPU driver links (libstdc++, libgcc_s, expat, zlib). A GPU driver (mesa, NVIDIA) is loaded into mpv
from the host, so a bundled copy of a library it shares would shadow the host's. `assemble.sh` skips them and
fails the build if one slips in; `verify` fails with `host_libraries_bundled:`. libva stays bundled (drivers are
dlopen'd from the host and bind to it; it must be at least the libva the host's Mesa was built against, see `src/sources.ts`).

For size, what the app's own Electron loads is left to the host as well: every host that runs the app has it.
That is the X11 client libraries (Electron NEEDS libX11, libxcb, libXext, libXfixes, libXrandr; they pull
libXrender, libXau, libXdmcp), ALSA, GLib and D-Bus (direct NEEDS), and the text stack libass uses (fontconfig,
freetype, harfbuzz, fribidi, through gtk-3 / pango / cairo). What only those pull in (pcre, uuid, graphite2,
png16, brotli) leaves with them. libXss, libXpresent and libpulse are not in that closure (Chromium dlopens
libpulse) and stay bundled. Checked on Ubuntu 22.04 (PulseAudio), 24.04, Fedora and Arch (PipeWire): ldd of
Electron and of the bundle clean; mpv plays through `--ao=pulse` everywhere and through `--ao=alsa` wherever the
distribution routes ALSA to its sound server (the host libasound loads the host's plugins; the jammy copy the
bundle used to carry could not load them on Fedora or Arch).

`assemble.sh` walks DT_NEEDED through bundled libraries only: a host library resolves its own dependencies
from the host, so a copy of them would never load. `verify` fails with `unreachable_libraries:` when a bundled
library is reachable only through a host library.

The host needs glibc ≥ 2.35 and a libstdc++ from GCC ≥ 11 (built on Ubuntu 22.04), plus — Debian/Ubuntu
package names — `libegl1 libgl1 libdrm2 libx11-6 libx11-xcb1 libxcb1 libxcb-dri3-0 libxext6 libxfixes3 libxrandr2
libxrender1 libxkbcommon0 libexpat1 zlib1g libstdc++6
libgcc-s1 libasound2t64 libglib2.0-0t64 libdbus-1-3 libfontconfig1 libfreetype6 libharfbuzz0b libfribidi0`
(`libasound2 libglib2.0-0` before the 64-bit time_t transition: Ubuntu 22.04, Debian 12). Every desktop has
them; our CI images install them. libxkbcommon is the host's (mpv's Wayland keyboard; Electron needs it too).
libwayland-client / -cursor / -egl are bundled from our 1.24 build: mpv built against 1.24 binds wl_compositor v6,
and jammy's 1.20 aborts on an event it doesn't know ("interface 'wl_surface' has no event 2", mpv hangs).

The Linux and Android recipes stay on `ubuntu:22.04` (Chris, 2026-11-23, dependency audit #3378 D33). Moving to
24.04 would raise the minimum host to glibc 2.39 and drop Ubuntu 22.04 and Debian 12 hosts. Revisit when 22.04
reaches end of standard support in 2027.

macOS: mpv is the executable of `Badger Player.app` (its own name, bundle id
`io.spacefleet.badger-desktop.player` and icon in the Dock: MPV-MODEL-03); packaging moves the app to
`Contents/Helpers/` and `lib/` to `Contents/Resources/deps/lib`. Every dylib has the install name `@rpath/<file>`
and `LC_RPATH @loader_path`; `bin/*` have `@loader_path/../lib`; mpv has exactly
`@executable_path/../../../lib` (dev checkout) and `@executable_path/../../../../Resources/deps/lib` (packaged).
The only non-FFmpeg dylib is MoltenVK, which libplacebo and mpv link directly as their Vulkan library (no
loader, no ICD lookup); codecs, libplacebo, shaderc, libass, freetype, harfbuzz, fribidi, zimg and LuaJIT are
static. Everything else comes from macOS (`/usr/lib`: zlib, iconv, libc++; `/System`: frameworks). Every Mach-O
is ad-hoc signed, no symlinks. `bin/sf-lifeline` is the parent-death guard the platform layer wraps ffmpeg with
(RT-LIFE-06; source `packages/desktop-platform-macos/native/sf-lifeline.c`).

## Use

```bash
bun scripts/fetch-deps.ts [--target linux-x64|windows-x64|macos-arm64|macos-x64|android-arm64|android-arm|android-x64|android-ia32]   # repo root; default = this host; idempotent
```

The published version is content addressed (`fl<FEATURE_LIST_VERSION>-<recipe hash 12>`), so there is no
lockfile: the script hashes the checked-out recipe, downloads `media-deps-<target>.tar.gz` from the GitHub release
`media-deps-<target>-<version>` of [spacefleet-io/media-deps](https://github.com/spacefleet-io/media-deps), checks
the `.sha256` sidecar and every file's hash from the manifest, caches in `~/.cache/spacefleet/deps`, and
extracts into `vendor/deps/<target>/`. Binary lookup is the platform layer's job
(`platform.binaries.resolve`), never done here.

Environment (all optional): `MEDIA_DEPS_BASE_URL` downloads from a mirror instead
(`<base>/media-deps-<target>-<version>/<file>`), `MEDIA_DEPS_FORKS_URL` fetches library sources from a mirror of the
forks (`<base>/<repo>`), and `MEDIA_DEPS_GH_TOKEN` (or `GH_TOKEN`) is a GitHub token, needed only to read the
releases and forks while they are private and to publish.

## Sources: forks only

Nothing is built from upstream. Every library (the 32 pins in `src/sources.ts` plus libplacebo's 6 submodules, in 34 fork repositories) has a
fork in the GitHub org [spacefleet-io](https://github.com/spacefleet-io), and the recipes fetch **one exact commit** from it
(`recipes/_shared/fetch-source.sh` refuses any other commit). Our patches live on `sf/<version>` branches; the
nightly `forks sync` mirrors every upstream branch and tag into the forks and never touches `sf/*`.

```bash
export MEDIA_DEPS_GH_TOKEN=…               # write (sync, pin) access to the forks; create also needs administration
bun run --cwd packages/media-deps forks sync [--only zimg,ffmpeg]   # what the nightly workflow runs
bun run --cwd packages/media-deps forks pin <id> [--ref <tag>]      # make/verify sf/<version>, print the sha for sources.ts
bun run --cwd packages/media-deps forks check                       # every pinned sha is the tip of its sf/<version>
```

Moving a library = a PR that pins the new commit in `src/sources.ts`; the sha is a build arg, so the recipe hash
(and with it the published version) changes by itself. `mpvmobile` (the iOS / tvOS libmpv) is mpv v0.41.0 plus two
commits of ours on `sf/0.41.0-mobile`: the `moltenvk` gpu context, and its fix keeping the vo display size when a new
file reconfigures without a layer resize. `forks pin` would drop them, so moving it means cherry-picking both commits
onto the new tag and pinning the new tip by hand. `ffmpegmobile` (every mobile target's ffmpeg) is the same:
the 8.1.3 release tree plus one commit on `sf/8.1.3-mobile`, `avformat/hls: seek non-primary playlists to the
requested time` (after a seek the audio playlist starts at the target, not the video segment start).

## Build / verify / publish

```bash
export MEDIA_DEPS_GH_TOKEN=…               # only while the forks are private
bun run --cwd packages/media-deps build:bundle --target linux-x64      # docker; wrap with the heavy-process lock
bun run --cwd packages/media-deps build:bundle --target macos-arm64    # native, on a Mac (Xcode pinned by the recipe)
bun run --cwd packages/media-deps build:bundle --target ios-arm64      # native, same Mac (Xcode + iPhoneOS SDK pinned)
bun run --cwd packages/media-deps build:bundle --target tvos-arm64     # native, same Mac (Xcode + AppleTVOS SDK pinned)
bun run --cwd packages/media-deps build:bundle --target ios-arm64-simulator   # native, same Mac (iPhoneSimulator SDK; tvos-arm64-simulator alike)
bun run --cwd packages/media-deps verify --target ios-arm64     # static: reads the Mach-O binaries, runs nothing (tvos-arm64 and the simulators alike)
bun run --cwd packages/media-deps verify --target linux-x64 [--bundle <dir>]   # RUNS the binaries: on the target OS
```

A macOS build keeps its sources and build trees (and skips finished libraries) when `MEDIA_DEPS_WORK_DIR` is
set, e.g. `MEDIA_DEPS_WORK_DIR=~/.cache/spacefleet/media-deps-work/macos-arm64`. To use a local build before it is
published, copy `out/<target>/{bin,lib,Badger Player.app,deps-manifest.json}` into `vendor/deps/<target>/`.

```bash
MEDIA_DEPS_GH_TOKEN=… bun run --cwd packages/media-deps publish:bundle --target linux-x64   # contents write on spacefleet-io/media-deps
bun run --cwd packages/media-deps source:archive --target linux-x64 --publish    # the matching source archive
```

A token, when set, reaches a docker build as a BuildKit secret (`forge_auth`), never as a build arg or in a layer; a
native build reads it from the `FORGE_AUTH` environment variable (`scripts/build.ts` sets it), never from an argument.

## Corresponding source

Every published bundle version has a `media-deps-<target>-source.tar.gz` (+ `.sha256`) next to it in the
same GitHub release: the exact tree of every library at its pinned commit (submodules in place),
the recipe, the feature list, the resolved build args and `SOURCES.json` (library, version, fork, commit,
upstream, licence). The desktop release workflows run `bun packages/media-deps/scripts/check-source-archive.ts`
and fail when the archive of the bundled version is missing.

The deps-build CI job does the same on every change under `packages/media-deps/` and
skips targets whose version (bundle and source archive) is already published. `verify` (src/verify.ts) asserts: every component of
`FFMPEG_COMPONENTS` and of the target's hardware families is really built (`ffmpeg -decoders -demuxers
-muxers -encoders -filters -protocols -bsfs`; `./configure` silently ignores typos), the software and
hardware encoders are listed, real 360p libx264 + aac, libx265 + dash, mp3 and mjpeg-still jobs run, mpv is
on FFmpeg 8 with the required features / video outputs / decoders / `astats`, the GPU path is compiled in
(`mpv --hwdec=help` / `--gpu-context=help` and `ffmpeg -hwaccels` list the target's `mpvRequiredHwdecs` /
`mpvRequiredGpuContexts` / `ffmpegRequiredHwaccelMethods`; listings only, CI has no GPU), mpv decodes the
result and answers JSON IPC with the product OSC loaded, (Linux) no host library / symlink / unresolved
library, and (macOS) every Mach-O is the target's single architecture with minos 14.0, links only `@rpath/`
libraries shipped in `lib/` plus `/usr/lib` and `/System`, carries exactly the layout's `LC_RPATH`s, passes
`codesign --verify`, and the player app's `Info.plist` names its executable and macOS 14.0.

## Media format test set (phone / TV, REL-DEPS-11)

A phone or TV libmpv ships only after it plays the media format test set on a real device of its platform.
`src/mediaTestSet.ts` lists one short fixture per container, codec and subtitle format the mobile build keeps
(`MOBILE_FEATURES`), with what playing it must show; `tests/mediaTestSet.test.ts` fails when a kept demuxer or
decoder has neither a fixture nor a reason in `MEDIA_TEST_SET_UNCOVERED`.

```bash
bun packages/media-deps/scripts/generate-media-test-set.ts [--force] [--only id,id]   # needs a full ffmpeg (encoders) on PATH
bun packages/media-deps/scripts/run-media-test-set-android.ts [--serial S] [--only id,id]   # debug/profile app installed
bun packages/media-deps/scripts/run-media-test-set-ios.ts --udid U [--only id,id] [--install] [--build]   # SB_MEDIA_TEST_SET=YES build
```

The generator writes about 20 MB to `cache/media-test-set/` (gitignored, never committed): synthetic lavfi
clips, a synthetic PGS file (`writeSyntheticPgs`, ffmpeg has no PGS encoder), and five FFmpeg FATE samples for the
codecs ffmpeg cannot encode (VC-1, WMV3, WMA Pro, MS-MPEG4v1, DTS-HD), pinned by sha256. It ffprobes every output
against its expectation and writes `expectations.json`, the platform-neutral contract a device runner reads. The
Android runner (`MediaTestSetActivity`, debug/profile source set of `packages/mobile-mpv-playback`) plays each
fixture through the app's libmpv with the app's options, serves HLS from a loopback HTTP server, loads subtitles
with `sub-add`, and checks the reported codecs, decoded sizes and audio parameters, playback progress, the
hardware decoder where required, and the subtitle pixels on screen. The driver pulls `report.json` and the
subtitle screenshots into `cache/media-test-set-report/<serial>/` and exits 1 on any failure.

The iPhone runner (`ios/TestSet/MediaTestSetRunner.swift` in `packages/mobile-mpv-playback`) is compiled only into
Debug builds or builds made with the xcodebuild setting `SB_MEDIA_TEST_SET=YES` (a plain Release build has none of
it) and starts only when the app is launched with the env `SB_MEDIA_TEST_SET=1`. It draws in its own window through
the app's `MpvEngine` (same options), makes the same checks, and also checks that every picture fills its
aspect-fit display rect (a moltenvk regression). The driver copies the set into the app's data container
(`Documents/media-test-set`, `xcrun devicectl device copy to`, about 5 s), launches the app with `devicectl device
process launch --console`, then copies `report.json`, a screenshot per video fixture and `playback.log` into
`cache/media-test-set-report/<udid>/`; it exits 1 on any failure. `--install` installs the last
`apps/badger/mobile/ios/build-device` Release build first.

## Files

- `src/features.ts` — THE shared kept-features list (each entry says why it is kept). Edit it to add a codec.
- `src/mediaTestSet.ts` — the phone/TV media format test set (fixtures + expectations); `src/syntheticMedia.ts` — synthetic YUV, WAV and PGS writers.
- `src/sources.ts` — every library: fork repo, pinned commit (`sha`), upstream, licence (`scripts/forks.ts`).
- `src/forks/` — fork maintenance (mirror, tag/tarball pin, release import); `src/sourceArchive.ts` — source archive + release gate.
- `src/target.ts` — what ONE OS adds (`DepsTarget`); `recipes/<id>/target.ts` fills it in.
- `recipes/<id>/` — the build (Dockerfile + helper scripts, or a native `build.sh`); `recipes/_shared/` — scripts
  every recipe reuses; `recipes/_macos/` — the one macOS build (`build.sh`, `macosTarget.ts`, the offline CPM
  stand-in MoltenVK's CMake build loads) both macOS recipes run.
- `src/plan.ts` (configure flags, docker plan, recipe hash, package coordinates), `src/verify.ts`,
  `src/registry.ts` (publish + fetch), `src/bundle.ts` (manifest + archive), `src/targets.ts` (discovery).

## Changing the feature list

Add the component name to `src/features.ts`, run `build` + `verify` for every target, bump
`FEATURE_LIST_VERSION` if a consumer could notice. The recipe hash changes, so CI republishes and every
checkout resolves the new bundle automatically.
