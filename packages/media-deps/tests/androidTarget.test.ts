import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MOBILE_FEATURES } from "../src/features";
import { dockerBuildArgs, ffmpegConfigureFlags, getPackageRoot, mpvMesonOptions } from "../src/plan";
import { loadMobileTarget } from "../src/targets";
import { androidLibraryFile, ffmpegConfigurationProblems } from "../src/verifyMobile";

const IDS = ["android-arm64", "android-arm", "android-x64", "android-ia32"] as const;

describe("android targets", () => {
  it("are mobile docker targets built from the shared mobile configuration", async () => {
    for (const id of IDS) {
      const target = await loadMobileTarget(id);
      expect(target).toMatchObject({ id, kind: "mobile", os: "android", builder: "docker", dockerPlatform: "linux/amd64" });
      const flags = ffmpegConfigureFlags(target);
      expect(flags).toEqual(expect.arrayContaining([...MOBILE_FEATURES.ffmpegBaseFlags, "--target-os=android", "--enable-mediacodec", "--enable-jni"]));
      expect(flags).toEqual(expect.arrayContaining(["--enable-decoder=h264_mediacodec", "--enable-decoder=hevc_mediacodec"]));
      // The configure line ffmpeg embeds is what verify reads: it must already pass as built.
      expect(ffmpegConfigurationProblems(flags.join(" "))).toEqual([]);
      expect(mpvMesonOptions(target)).toEqual(expect.arrayContaining(["-Dgpl=false", "-Dlibmpv=true", "-Degl-android=enabled", "-Dvulkan=disabled"]));
    }
  });

  /** @req PLAT-TV-05 one libmpv bundle per Android ABI, each built for its own NDK triple and CPU. */
  it("cover every Android ABI and differ only in the architecture build args", async () => {
    const targets = await Promise.all(IDS.map((id) => loadMobileTarget(id)));
    const args = targets.map((target) => dockerBuildArgs(target));
    expect(args.map(({ ANDROID_ABI, ANDROID_TRIPLE, MESON_CPU_FAMILY }) => [ANDROID_ABI, ANDROID_TRIPLE, MESON_CPU_FAMILY])).toEqual([
      ["arm64-v8a", "aarch64-linux-android", "aarch64"],
      ["armeabi-v7a", "arm-linux-androideabi", "arm"],
      ["x86_64", "x86_64-linux-android", "x86_64"],
      ["x86", "i686-linux-android", "x86"],
    ]);
    const [first, ...rest] = args;
    for (const other of rest) {
      const differing = Object.keys(first!).filter((key) => first![key] !== other[key]);
      expect(differing.sort()).toEqual(["ANDROID_ABI", "ANDROID_TRIPLE", "FFMPEG_FLAGS", "MESON_CPU_FAMILY"]);
    }
  });

  it("build 32-bit ARM with NEON and 32-bit x86 without assembly (Android refuses text relocations)", async () => {
    expect(ffmpegConfigureFlags(await loadMobileTarget("android-arm"))).toEqual(expect.arrayContaining(["--arch=arm", "--cpu=armv7-a", "--enable-neon"]));
    expect(ffmpegConfigureFlags(await loadMobileTarget("android-ia32"))).toEqual(expect.arrayContaining(["--arch=x86", "--disable-asm"]));
  });

  it("build from one Dockerfile content (the four recipe copies are identical)", () => {
    const [first, ...rest] = IDS.map((id) => readFileSync(path.join(getPackageRoot(), "recipes", id, "Dockerfile"), "utf8"));
    for (const other of rest) expect(other).toBe(first);
  });

  it("name every bundle library by its jniLibs file name", async () => {
    const target = await loadMobileTarget("android-arm64");
    expect(target.libraries.map(androidLibraryFile)).toEqual([
      "libavcodec.so",
      "libavfilter.so",
      "libavformat.so",
      "libavutil.so",
      "libswresample.so",
      "libswscale.so",
      "libmpv.so",
      "libplayer.so",
      "libc++_shared.so",
    ]);
  });
});
