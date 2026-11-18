import type { MobileDepsTarget } from "../../src/target";

/**
 * The four Apple mobile recipes differ only in the SDK they build against: ios-arm64 (iPhone) and tvos-arm64 (Apple
 * TV) for the devices, ios-arm64-simulator and tvos-arm64-simulator for the Xcode simulators the older-OS and Apple TV
 * tests run on (REL-MOB-02, REL-TV-03). All build natively on the Apple Silicon runner with the one shared
 * `recipes/_apple-mobile/build.sh` from the shared mobile configuration (`MOBILE_FEATURES`, REL-DEPS-11), so the Apple
 * TV plays through the same libmpv as the iPhone (MPV-TV-01) and a simulator through the same libmpv as the device.
 * Output: one `.xcframework` per dynamic library (`libraries`), each a single slice named like the target id
 * (`ios-arm64`, `ios-arm64-simulator`, …: Xcode's own slice identifiers).
 *
 * A simulator is its own published bundle, never a second slice inside the device bundle: the device bundle keeps its
 * size (the simulator slice would double its download for every device build), the two build in parallel CI jobs, and
 * a simulator build can fail without blocking a device release. fetch-ios-deps.ts joins the two slices into one
 * xcframework per library on the developer's machine, so Xcode picks the slice per destination.
 */
const PLATFORMS = {
  // iPhone: React Native 0.85's floor (`min_ios_version_supported`).
  ios: { sdk: "iphoneos", simulatorSdk: "iphonesimulator", minOs: "15.1" },
  // Apple TV: react-native-tvos 0.85's floor (`min_supported_versions` tvos = 15.1), which also covers Apple TV HD
  // (PLAT-TV-04). MoltenVK itself only needs tvOS 13.
  tvos: { sdk: "appletvos", simulatorSdk: "appletvsimulator", minOs: "15.1" },
} as const;

export type AppleVariant = "device" | "simulator";

export const appleMobileTarget = (os: keyof typeof PLATFORMS, variant: AppleVariant = "device"): MobileDepsTarget => ({
  id: variant === "simulator" ? `${os}-arm64-simulator` : `${os}-arm64`,
  kind: "mobile",
  os,
  ...(variant === "simulator" ? { simulator: true } : {}),
  arch: "arm64",
  builder: "native",
  sources: [
    "ffmpegmobile",
    "mpvmobile",
    "dav1d",
    "freetype",
    "harfbuzz",
    "fribidi",
    "libass",
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
  // VideoToolbox decode only (no encoder in the mobile configuration); FFmpeg probes nothing on its own.
  ffmpegFlags: ["--enable-cross-compile", "--target-os=darwin", "--arch=aarch64", "--enable-videotoolbox"],
  ffmpegHwaccels: ["h264_videotoolbox", "hevc_videotoolbox", "vp9_videotoolbox", "av1_videotoolbox"],
  // Vulkan through MoltenVK, linked directly (no loader); shaderc compiles libplacebo's GLSL to SPIR-V.
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
  // vo=gpu-next on Vulkan (MoltenVK) drawing into the CAMetalLayer the app passes as `wid` (the `moltenvk` GPU
  // context, our mpv fork patch); ao=audiounit; hwdec=videotoolbox with frames kept on the GPU (videotoolbox-pl).
  mpvMesonOptions: [
    "-Dvulkan=enabled",
    "-Dmoltenvk=enabled",
    "-Dvideotoolbox-pl=enabled",
    "-Daudiounit=enabled",
    "-Dcocoa=disabled",
    "-Dswift-build=disabled",
    "-Dcoreaudio=disabled",
    "-Davfoundation=disabled",
    "-Dgl=disabled",
    "-Dios-gl=disabled",
    "-Dvideotoolbox-gl=disabled",
    "-Dmacos-cocoa-cb=disabled",
    "-Dmacos-media-player=disabled",
    "-Dmacos-touchbar=disabled",
    "-Dshaderc=disabled",
    "-Dspirv-cross=disabled",
  ],
  mpvRequiredFeatures: ["vulkan", "moltenvk", "videotoolbox-pl", "audiounit"],
  libraries: ["Libavutil", "Libavcodec", "Libavformat", "Libavfilter", "Libswresample", "Libswscale", "Libmpv", "MoltenVK"],
  buildArgs: {
    APPLE_SDK: variant === "simulator" ? PLATFORMS[os].simulatorSdk : PLATFORMS[os].sdk,
    APPLE_MIN_OS: PLATFORMS[os].minOs,
    // The toolchain is part of the published version: build.sh refuses any other Xcode / SDK.
    XCODE_VERSION: "26.4",
    APPLE_SDK_VERSION: "26.4",
  },
  recipeInputs: ["recipes/_apple-mobile", "recipes/_macos/cpm.cmake"],
});
