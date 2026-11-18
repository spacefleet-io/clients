import type { MobileDepsTarget } from "../../src/target";

/**
 * The four Android recipes, one per Android ABI (PLAT-TV-05): android-arm64 (64-bit ARM phones and TVs), android-arm
 * (32-bit ARMv7: many Android TV boxes run a 32-bit system even on a 64-bit chip), android-x64 (the emulator, x86
 * Chromebooks and boxes) and android-ia32 (32-bit x86 boxes). They differ only in the architecture: all build in
 * Docker on a Linux host with the one shared Dockerfile content and the pinned NDK (its version and checksum are
 * build args, so a new NDK is a new published version).
 *
 * The bundle is what `packages/mobile-mpv-playback/android` loads through `is.xyz.mpv.MPVLib`: libmpv + the ffmpeg
 * libraries it links, `libplayer.so` (the JNI bridge, vendored from mpv-android in `_android/jni`) and the NDK's
 * `libc++_shared.so`, as `lib/<android abi>/<name>.so` (the jniLibs layout gradle consumes as is).
 */

/** NDK r27b = the NDK the React Native app builds with (apps/badger/mobile/android/build.gradle `ndkVersion`). */
const NDK = {
  version: "27.1.12297006",
  url: "https://dl.google.com/android/repository/android-ndk-r27b-linux.zip",
  sha256: "33e16af1a6bbabe12cad54b2117085c07eab7e4fa67cdd831805f0e94fd826c1",
};

/** = minSdk of packages/mobile-mpv-playback/android (AImageReader private format and AAudio need 26). */
const ANDROID_API = "26";

/**
 * Per-ABI build facts. `triple` is the NDK sysroot directory (where libc++_shared.so lives); env.sh derives the
 * clang driver name from it (armv7a-… for arm). `ffmpegArch` is ffmpeg's `--arch`/`--cpu` pair, plus `--enable-neon`
 * on ARMv7 (every armeabi-v7a device has NEON since NDK r21). ia32 builds ffmpeg without assembly: its x86-32 asm
 * needs text relocations in a shared library, which Android refuses to load (API 23+), and MediaCodec does the
 * heavy decoding on those boxes anyway.
 */
const ABIS = {
  arm64: { abi: "arm64-v8a", triple: "aarch64-linux-android", meson: "aarch64", ffmpegArch: ["--arch=aarch64", "--cpu=armv8-a"] },
  arm: { abi: "armeabi-v7a", triple: "arm-linux-androideabi", meson: "arm", ffmpegArch: ["--arch=arm", "--cpu=armv7-a", "--enable-neon"] },
  x64: { abi: "x86_64", triple: "x86_64-linux-android", meson: "x86_64", ffmpegArch: ["--arch=x86_64", "--cpu=generic"] },
  ia32: { abi: "x86", triple: "i686-linux-android", meson: "x86", ffmpegArch: ["--arch=x86", "--cpu=i686", "--disable-asm"] },
} as const satisfies Record<MobileDepsTarget["arch"], { abi: string; triple: string; meson: string; ffmpegArch: readonly string[] }>;

export const androidTarget = (arch: MobileDepsTarget["arch"]): MobileDepsTarget => {
  const { abi, triple, meson, ffmpegArch } = ABIS[arch];
  return {
    id: `android-${arch}`,
    kind: "mobile",
    os: "android",
    arch,
    builder: "docker",
    dockerPlatform: "linux/amd64",
    sources: ["ffmpegmobile", "mpv", "dav1d", "freetype", "harfbuzz", "fribidi", "expat", "fontconfig", "libass", "libplacebo"],
    ffmpegFlags: [
      "--target-os=android",
      "--enable-cross-compile",
      ...ffmpegArch,
      // MediaCodec hardware decode (mpv --hwdec=mediacodec / mediacodec-copy): ffmpeg's *_mediacodec decoders,
      // reached through the NDK AMediaCodec API and JNI (libplayer hands ffmpeg the JavaVM + app context).
      "--enable-jni",
      "--enable-mediacodec",
      ...["h264", "hevc", "vp8", "vp9", "av1", "mpeg2", "mpeg4"].map((codec) => `--enable-decoder=${codec}_mediacodec`),
    ],
    // MediaCodec is a decoder wrapper in ffmpeg, not an hwaccel.
    ffmpegHwaccels: [],
    // OpenGL ES only (mpv's `android` gpu-context is EGL); no Vulkan on Android (MPV-GPU-* desktop only).
    libplaceboMesonOptions: [
      "-Dvulkan=disabled",
      "-Dvk-proc-addr=disabled",
      "-Dopengl=enabled",
      "-Dgl-proc-addr=enabled",
      "-Dd3d11=disabled",
      "-Dglslang=disabled",
      "-Dshaderc=disabled",
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
    // What packages/mobile-mpv-playback sets: vo=gpu + gpu-context=android (EGL on the app's Surface),
    // hwdec=mediacodec,mediacodec-copy (AImageReader zero-copy needs android-media-ndk), ao=opensles (audiotrack /
    // aaudio built as fallbacks). bionic has iconv only from API 28: off (minSdk 26).
    mpvMesonOptions: [
      "-Dgl=enabled",
      "-Degl-android=enabled",
      "-Dandroid-media-ndk=enabled",
      "-Dvulkan=disabled",
      "-Dopensles=enabled",
      "-Daaudio=enabled",
      "-Daudiotrack=enabled",
      "-Diconv=disabled",
    ],
    mpvRequiredFeatures: ["android", "gl", "egl-android", "android-media-ndk", "opensles", "aaudio", "audiotrack"],
    libraries: ["Libavcodec", "Libavfilter", "Libavformat", "Libavutil", "Libswresample", "Libswscale", "Libmpv", "Libplayer", "Libc++_shared"],
    buildArgs: {
      NDK_VERSION: NDK.version,
      NDK_URL: NDK.url,
      NDK_SHA256: NDK.sha256,
      ANDROID_API,
      ANDROID_ABI: abi,
      ANDROID_TRIPLE: triple,
      MESON_CPU_FAMILY: meson,
    },
    recipeInputs: ["recipes/_android"],
  };
};
