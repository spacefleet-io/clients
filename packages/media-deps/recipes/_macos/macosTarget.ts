import type { DepsTarget } from "../../src/target";

/**
 * The two macOS recipes (macos-arm64, macos-x64) differ only in the architecture: both build natively on the
 * Apple Silicon runner with the one shared script `recipes/_macos/build.sh` (x64 = `-arch x86_64` cross build,
 * its test programs run under Rosetta 2). Never a universal binary (PLAT-DESK-05).
 */
export const macosTarget = (arch: DepsTarget["arch"]): DepsTarget => {
  const macArch = arch === "arm64" ? "arm64" : "x86_64";
  return {
    id: `macos-${arch}`,
    kind: "desktop",
    os: "macos",
    arch,
    nodePlatform: "darwin",
    exeSuffix: "",
    builder: "native",
    sources: [
      "ffmpeg",
      "mpv",
      "x264",
      "x265macos",
      "lame",
      "dav1d",
      "freetype",
      "harfbuzz",
      "fribidi",
      "libass",
      "zimg",
      "luajit",
      "shaderc",
      "glslang",
      "spirvtools",
      "spirvheaders",
      "libplacebo",
      "moltenvk",
      "moltenvkspirvcross",
      "cereal",
      "vulkanheaders",
    ],
    ffmpegFlags: [
      "--enable-videotoolbox", // VideoToolbox: hardware decode + h264/hevc encode on every Mac
      "--enable-audiotoolbox",
      ...(arch === "x64" ? ["--enable-cross-compile", "--arch=x86_64", "--target-os=darwin"] : []),
    ],
    hardwareEncoders: ["videotoolbox"],
    // mpv's --hwdec=videotoolbox goes through these FFmpeg hwaccels (frames stay on the GPU via videotoolbox-pl).
    ffmpegHwaccels: ["h264_videotoolbox", "hevc_videotoolbox", "vp9_videotoolbox", "av1_videotoolbox"],
    ffmpegRequiredHwaccelMethods: ["videotoolbox"],
    // Vulkan through MoltenVK, linked directly (vk-proc-addr against libMoltenVK: no loader, no ICD lookup);
    // shaderc is the GLSL -> SPIR-V compiler Vulkan needs (MPV-GPU-03).
    libplaceboMesonOptions: [
      "-Dvulkan=enabled",
      "-Dvk-proc-addr=enabled",
      "-Dshaderc=enabled",
      "-Dglslang=disabled",
      "-Dopengl=disabled",
      "-Dgl-proc-addr=disabled",
      "-Dd3d11=disabled",
      "-Dlcms=disabled",
      "-Ddovi=disabled",
      "-Dlibdovi=disabled",
      "-Ddemos=false",
      "-Dtests=false",
      "-Dbench=false",
      "-Dfuzz=false",
      "-Dunwind=disabled",
      "-Dxxhash=disabled",
    ],
    // Later -D wins in meson: `-Dvulkan=enabled` overrides the shared list's `-Dvulkan=disabled`.
    mpvMesonOptions: [
      "-Dvulkan=enabled",
      "-Dcocoa=enabled",
      "-Dswift-build=enabled",
      "-Dcoreaudio=enabled",
      "-Dvideotoolbox-pl=enabled",
      "-Davfoundation=disabled",
      "-Daudiounit=disabled",
      "-Dgl=disabled",
      "-Dgl-cocoa=disabled",
      "-Dvideotoolbox-gl=disabled",
      "-Dmacos-cocoa-cb=disabled",
      "-Dmacos-media-player=disabled",
      "-Dmacos-touchbar=disabled",
      "-Dshaderc=disabled",
      "-Dspirv-cross=disabled",
    ],
    mpvRequiredFeatures: ["cocoa", "coreaudio", "swift", "vulkan", "videotoolbox-pl"],
    mpvRequiredVideoOutputs: [],
    // `--hwdec=auto-safe` picks VideoToolbox; `--vo=gpu(-next)` draws through Vulkan on Metal (MoltenVK).
    mpvRequiredHwdecs: ["videotoolbox", "videotoolbox-copy"],
    mpvRequiredGpuContexts: ["macvk"],
    ipc: "unix-socket",
    buildArgs: {
      MAC_ARCH: macArch,
      MACOS_MIN: "14.0",
      // The toolchain is part of the published version: build.sh refuses any other Xcode / SDK.
      XCODE_VERSION: "26.4",
      MACOS_SDK_VERSION: "26.4",
    },
    recipeInputs: [
      "recipes/_macos",
      "../desktop-platform-macos/native/sf-lifeline.c",
      "../../apps/badger/desktop/installer/icon.png",
    ],
    layout: { mpv: "Badger Player.app/Contents/MacOS/mpv", libDir: "lib" },
  };
};
