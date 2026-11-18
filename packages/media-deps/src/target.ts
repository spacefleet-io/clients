import type { HardwareEncoderFamily } from "./features";
import type { SourceId, SourceSpec } from "./sources";

/**
 * Everything ONE OS adds on top of the shared feature list. A recipe directory
 * `recipes/<id>/` holds `target.ts` (default-exports a `DepsTarget`) plus the Dockerfile (or
 * native build script) it builds with. Adding an OS = adding such a directory; no shared file
 * lists targets (src/targets.ts discovers them).
 *
 * Two kinds: a DESKTOP target ships ffmpeg + ffprobe + the mpv player built from the desktop feature
 * list (`FFMPEG_COMPONENTS`, `MPV_FEATURES`); a MOBILE target (phones and TVs) ships only the embedded
 * libmpv + its libraries built from the one shared mobile configuration (`MOBILE_FEATURES`): playback
 * only, no encoder, LGPL (REL-DEPS-11).
 */
type DepsTargetBase = {
  /** `<os>-<arch>`: the directory name under recipes/, vendor/deps/ and `<resources>/deps/`. */
  id: string;
  /** Node-style CPU name. `arm` (32-bit ARMv7) and `ia32` (32-bit x86) exist only as Android targets (PLAT-TV-05). */
  arch: "x64" | "arm64" | "arm" | "ia32";
  /** Where the recipe builds. "docker": built here on a Linux host. "native": on a runner of that OS. */
  builder: "docker" | "native";
  /** `docker buildx --platform` value (builder "docker" only). */
  dockerPlatform?: string;
  /** Pinned sources the recipe consumes (each becomes SRC_<ID>_URL / SRC_<ID>_SHA256 build args). */
  sources: readonly SourceId[];
  /** Sources only this OS needs (a macOS-only library), or a pin this OS ships under another licence: keeps src/sources.ts free of OS edits. */
  extraSources?: Readonly<Record<string, SourceSpec>>;
  /** ffmpeg configure flags this OS adds (cross-compile, hardware APIs, hwaccels). */
  ffmpegFlags: readonly string[];
  /** `--enable-hwaccel=` names this OS needs (the decode side of each GPU API: NVDEC, VA-API, D3D11VA, DXVA2, VideoToolbox). */
  ffmpegHwaccels: readonly string[];
  /** libplacebo meson options. */
  libplaceboMesonOptions: readonly string[];
  /** mpv meson options on top of the kind's shared list (`MPV_FEATURES.mesonCommon` / `MOBILE_FEATURES.mpvMesonCommon`). */
  mpvMesonOptions: readonly string[];
  /** Extra mpv "List of enabled features" entries this OS must show. */
  mpvRequiredFeatures: readonly string[];
  /** Extra static build args the recipe reads (hashed). */
  buildArgs?: Readonly<Record<string, string>>;
  /**
   * Files or directories outside `recipes/_shared` and `recipes/<id>` the recipe reads (paths relative to the
   * package root, e.g. a shared `recipes/_macos` script or a helper's C source): hashed like the recipe itself.
   */
  recipeInputs?: readonly string[];
};

export type DesktopDepsTarget = DepsTargetBase & {
  kind: "desktop";
  os: "linux" | "windows" | "macos";
  /** Node's `process.platform` of a machine this bundle runs on; how a host picks its own target (see `hostTarget`). */
  nodePlatform: "linux" | "win32" | "darwin";
  /** Executable suffix: "" or ".exe". */
  exeSuffix: "" | ".exe";
  /** Hardware encoder families this OS drives; each must expose h264_<f> and hevc_<f>. */
  hardwareEncoders: readonly HardwareEncoderFamily[];
  /** `ffmpeg -hwaccels` device types the built ffmpeg must list (e.g. "vaapi", "cuda", "d3d11va"). */
  ffmpegRequiredHwaccelMethods: readonly string[];
  /** Extra `--vo=help` entries this OS must list (beyond the shared gpu/gpu-next/null). */
  mpvRequiredVideoOutputs: readonly string[];
  /** `--hwdec=help` methods mpv must offer: the hardware decoders `--hwdec=auto-safe` can pick on this OS. */
  mpvRequiredHwdecs: readonly string[];
  /** `--gpu-context=help` entries mpv must offer: without one, `--vo=gpu` cannot start and mpv draws on the CPU. */
  mpvRequiredGpuContexts: readonly string[];
  /** How mpv's JSON IPC endpoint is addressed on this OS (verifier connects to it). */
  ipc: "unix-socket" | "named-pipe";
  /**
   * Where the player and the shared libraries sit in the bundle (POSIX paths relative to the bundle root).
   * Default: `bin/mpv<exe>` and `bin` (a flat bin/ next to ffmpeg/ffprobe).
   */
  layout?: { mpv: string; libDir: string };
  /**
   * Shell globs of libraries the bundle must NEVER carry: the host's C runtime and graphics stack (glibc, GL/EGL,
   * libdrm, X11/xcb, Vulkan, Wayland) and the runtime a host GPU driver links against (libstdc++, libgcc_s, expat,
   * zlib). A GPU driver is loaded into mpv's process from the host; a bundled copy of a library it shares would shadow
   * the host's and break it. The recipe skips them (build arg HOST_LIBRARIES) and the verifier fails if one ships.
   */
  hostLibraries?: readonly string[];
};

/**
 * A phone / TV target: the libmpv an app embeds (REL-DEPS-11). Built from `MOBILE_FEATURES` (shared by every
 * mobile and TV platform) plus this platform's hardware decoding, audio output and video output. The bundle is
 * libraries only (nothing runs on the build host), so `verify` inspects it statically.
 */
export type MobileDepsTarget = DepsTargetBase & {
  kind: "mobile";
  os: "ios" | "tvos" | "android";
  /** Apple only: the bundle is for the Xcode simulator (platform IOSSIMULATOR / TVOSSIMULATOR), not the device. */
  simulator?: true;
  /** Every dynamic library of the bundle, by name (Apple: `<Name>.xcframework` holding `<Name>.framework`). */
  libraries: readonly string[];
};

export type DepsTarget = DesktopDepsTarget | MobileDepsTarget;
