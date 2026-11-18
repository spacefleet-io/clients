import { describe, expect, it } from "vitest";
import { DESKTOP_ONLY_DECODERS, DESKTOP_ONLY_DEMUXERS, FFMPEG_COMPONENTS, MOBILE_FEATURES } from "../src/features";
import { computeRecipeHash, dockerBuildArgs, ffmpegConfigureFlags, mpvMesonOptions, targetSources } from "../src/plan";
import { sfBranchName } from "../src/forks/names";
import { buildSourcesManifest } from "../src/sourceManifest";
import { SOURCES } from "../src/sources";
import { hostTarget, loadDesktopTarget, loadMobileTarget, loadTargets } from "../src/targets";
import {
  applePlatformName,
  embeddedFfmpegConfiguration,
  embeddedFfmpegLicense,
  embeddedMpvFeatures,
  ffmpegConfigurationProblems,
  mpvFeatureProblems,
} from "../src/verifyMobile";

/**
 * REL-DEPS-11: the libmpv embedded in the phone / TV apps is our own build from ONE shared mobile configuration:
 * every file type the desktop plays, no encoder, no GPL-only part (the whole library is LGPL), release + stripped.
 */
const mesonValues = (options: readonly string[]) => {
  const values: Record<string, string> = {};
  for (const option of options) {
    const match = /^-D([^=]+)=(.*)$/.exec(option);
    if (match) values[match[1]!] = match[2]!;
  }
  return values;
};

describe("shared mobile configuration (REL-DEPS-11)", () => {
  it("plays what the desktop plays: its demuxers, parsers and decoders minus the desktop-only internals", () => {
    const { ffmpegComponents } = MOBILE_FEATURES;
    console.info(
      `[media-deps:mobile] demuxers=${ffmpegComponents.demuxer.length} decoders=${ffmpegComponents.decoder.length} parsers=${ffmpegComponents.parser.length} protocols=${ffmpegComponents.protocol.join(",")}`
    );
    expect(ffmpegComponents.demuxer).toEqual(FFMPEG_COMPONENTS.demuxer.filter((name) => !DESKTOP_ONLY_DEMUXERS.includes(name)));
    expect(ffmpegComponents.decoder).toEqual(FFMPEG_COMPONENTS.decoder.filter((name) => !DESKTOP_ONLY_DECODERS.includes(name)));
    expect(ffmpegComponents.parser).toEqual(FFMPEG_COMPONENTS.parser);
    for (const codec of ["h264", "hevc", "libdav1d", "vp9", "aac", "opus", "flac", "ass", "subrip", "pgssub"]) {
      expect(ffmpegComponents.decoder).toContain(codec);
    }
    for (const demuxer of ["matroska", "mov", "mpegts", "hls"]) expect(ffmpegComponents.demuxer).toContain(demuxer);
  });

  it("contains no encoder, no muxer, no device and no TLS", () => {
    const { ffmpegComponents } = MOBILE_FEATURES;
    expect(ffmpegComponents.encoder).toEqual([]);
    expect(ffmpegComponents.muxer).toEqual([]);
    expect(ffmpegComponents.indev).toEqual([]);
    expect(ffmpegComponents.protocol).not.toContain("https");
    expect(ffmpegComponents.protocol).not.toContain("tls");
  });

  it("builds mpv as an LGPL library only: no player program, no scripting, no screenshots", () => {
    const values = mesonValues(MOBILE_FEATURES.mpvMesonCommon);
    expect(values).toMatchObject({ libmpv: "true", cplayer: "false", gpl: "false", lua: "disabled", javascript: "disabled", jpeg: "disabled" });
    expect(MOBILE_FEATURES.mpvRequiredFeatures).toEqual(["ffmpeg", "libass", "libplacebo", "zlib"]);
    expect(MOBILE_FEATURES.mpvForbiddenFeatures).toEqual(["gpl", "cplayer"]);
  });
});

// iPhone and Apple TV, device and Xcode simulator: one shared Apple mobile recipe and configuration, only the SDK
// differs (MPV-TV-01; the simulators carry the older-OS and Apple TV tests, REL-MOB-02 / REL-TV-03).
describe.each([
  { id: "ios-arm64", sdk: "iphoneos", platform: "IOS" },
  { id: "tvos-arm64", sdk: "appletvos", platform: "TVOS" },
  { id: "ios-arm64-simulator", sdk: "iphonesimulator", platform: "IOSSIMULATOR" },
  { id: "tvos-arm64-simulator", sdk: "appletvsimulator", platform: "TVOSSIMULATOR" },
])("$id target", ({ id, sdk, platform }) => {
  it("is discovered as a mobile target and never picked as a desktop host", async () => {
    const targets = await loadTargets();
    const apple = targets.find((target) => target.id === id);
    console.info(`[media-deps:mobile] targets: ${targets.map((target) => `${target.id}(${target.kind})`).join(" ")}`);
    expect(apple?.kind).toBe("mobile");
    expect((await hostTarget("darwin", "arm64")).id).toBe("macos-arm64");
    await expect(loadDesktopTarget(id)).rejects.toThrow(`not_a_desktop_target:${id}`);
    await expect(loadMobileTarget("linux-x64")).rejects.toThrow("not_a_mobile_target:linux-x64");
  });

  it("configures FFmpeg LGPL, decode-only, with VideoToolbox hwaccels", async () => {
    const flags = ffmpegConfigureFlags(await loadMobileTarget(id));
    console.info(`[media-deps:mobile] ${id} ffmpeg flags (${flags.length}): ${flags.filter((flag) => !flag.includes("=")).join(" ")}`);
    expect(flags.filter((flag) => /^--enable-(gpl|nonfree|version3)$/.test(flag))).toEqual([]);
    expect(flags.filter((flag) => /^--enable-(encoder|muxer)=/.test(flag))).toEqual([]);
    expect(flags.filter((flag) => /^--enable-lib(x264|x265|mp3lame)$/.test(flag))).toEqual([]);
    expect(flags).toEqual(expect.arrayContaining(["--disable-programs", "--disable-everything", "--enable-libdav1d", "--enable-videotoolbox"]));
    for (const codec of ["h264", "hevc", "vp9", "av1"]) expect(flags).toContain(`--enable-hwaccel=${codec}_videotoolbox`);
    expect(new Set(flags).size).toBe(flags.length);
    expect(ffmpegConfigurationProblems(flags.join(" "))).toEqual([]);
  });

  it("configures mpv for gpu-next on MoltenVK, AudioUnit and VideoToolbox, still LGPL", async () => {
    const target = await loadMobileTarget(id);
    const options = mpvMesonOptions(target);
    const values = mesonValues(options);
    console.info(`[media-deps:mobile] ${id} mpv meson options: ${options.join(" ")}`);
    expect(values).toMatchObject({
      gpl: "false",
      libmpv: "true",
      cplayer: "false",
      vulkan: "enabled",
      moltenvk: "enabled",
      "videotoolbox-pl": "enabled",
      audiounit: "enabled",
      cocoa: "disabled",
      gl: "disabled",
    });
    expect(target.mpvRequiredFeatures).toEqual(expect.arrayContaining(["moltenvk", "vulkan", "videotoolbox-pl", "audiounit"]));
  });

  it("hands the recipe its SDK, minimum OS and toolchain pins, and hashes the shared Apple recipe", async () => {
    const target = await loadMobileTarget(id);
    const args = dockerBuildArgs(target);
    console.info(`[media-deps:mobile] ${id} recipe ${computeRecipeHash(target).slice(0, 12)} APPLE_SDK=${args.APPLE_SDK} APPLE_MIN_OS=${args.APPLE_MIN_OS}`);
    expect(args).toMatchObject({ APPLE_SDK: sdk, APPLE_MIN_OS: "15.1" });
    expect(applePlatformName(target)).toBe(platform);
    expect(args).not.toHaveProperty("HOST_LIBRARIES");
    expect(target.recipeInputs).toContain("recipes/_apple-mobile");
    expect(target.libraries).toEqual(expect.arrayContaining(["Libavcodec", "Libmpv", "MoltenVK"]));
  });
});

describe("Apple TV and iPhone share one libmpv (MPV-TV-01)", () => {
  it("differ only in the device SDK: same sources, FFmpeg flags, mpv and libplacebo options, libraries", async () => {
    const ios = await loadMobileTarget("ios-arm64");
    const tvos = await loadMobileTarget("tvos-arm64");
    expect(tvos.os).toBe("tvos");
    expect(targetSources(tvos)).toEqual(targetSources(ios));
    expect(ffmpegConfigureFlags(tvos)).toEqual(ffmpegConfigureFlags(ios));
    expect(mpvMesonOptions(tvos)).toEqual(mpvMesonOptions(ios));
    expect(tvos.libplaceboMesonOptions).toEqual(ios.libplaceboMesonOptions);
    expect(tvos.libraries).toEqual(ios.libraries);
    const { APPLE_SDK: tvSdk, ...tvArgs } = dockerBuildArgs(tvos);
    const { APPLE_SDK: phoneSdk, ...phoneArgs } = dockerBuildArgs(ios);
    console.info(`[media-deps:mobile] apple SDKs ios=${phoneSdk} tvos=${tvSdk}; tvos recipe ${computeRecipeHash(tvos).slice(0, 12)} ios recipe ${computeRecipeHash(ios).slice(0, 12)}`);
    expect(tvArgs).toEqual(phoneArgs);
    expect(computeRecipeHash(tvos)).not.toBe(computeRecipeHash(ios));
  });
});

describe("mobile ffmpeg pin (REL-DEPS-11)", () => {
  // The phone / TV ffmpeg is the 8.1.3 release tree plus our HLS seek patch (`avformat/hls: seek non-primary
  // playlists to the requested time`) on sf/8.1.3-mobile; desktop keeps the unpatched `ffmpeg` pin.
  it("builds every mobile target from ffmpegmobile and every desktop target from ffmpeg", async () => {
    const targets = await loadTargets();
    for (const target of targets) {
      const ids = Object.keys(targetSources(target));
      console.info(`[media-deps:mobile] ${target.id}(${target.kind}) ffmpeg source: ${ids.filter((id) => id.startsWith("ffmpeg")).join(",")}`);
      if (target.kind === "mobile") {
        expect(ids, target.id).toContain("ffmpegmobile");
        expect(ids, target.id).not.toContain("ffmpeg");
        expect(dockerBuildArgs(target).SRC_FFMPEGMOBILE_SHA, target.id).toBe(SOURCES.ffmpegmobile.sha);
      } else {
        expect(ids, target.id).toContain("ffmpeg");
        expect(ids, target.id).not.toContain("ffmpegmobile");
      }
    }
  });

  it("pins the patched commit on sf/<ffmpeg version>-mobile, from the same release as desktop", () => {
    const mobile = SOURCES.ffmpegmobile;
    expect(mobile.sha).toBe("85ed917ac0f7bd62b25535920c25680754f9c91a");
    expect(mobile.sha).not.toBe(SOURCES.ffmpeg.sha);
    expect(sfBranchName(mobile.version)).toBe(`${sfBranchName(SOURCES.ffmpeg.version)}-mobile`);
    expect(mobile.repo).toBe(SOURCES.ffmpeg.repo);
    expect(mobile.upstreamRef).toBe(SOURCES.ffmpeg.upstreamRef);
    expect(mobile.release).toEqual(SOURCES.ffmpeg.release);
    expect(mobile.license).toBe("LGPL-2.1-or-later");
  });
});

describe("an Xcode simulator plays through the device's libmpv (REL-MOB-02, REL-TV-03)", () => {
  it.each(["ios", "tvos"])("%s simulator differs from the device only in the SDK and its id", async (os) => {
    const device = await loadMobileTarget(`${os}-arm64`);
    const simulator = await loadMobileTarget(`${os}-arm64-simulator`);
    expect(simulator.os).toBe(device.os);
    expect(simulator.simulator).toBe(true);
    expect(device.simulator).toBeUndefined();
    expect(targetSources(simulator)).toEqual(targetSources(device));
    expect(ffmpegConfigureFlags(simulator)).toEqual(ffmpegConfigureFlags(device));
    expect(mpvMesonOptions(simulator)).toEqual(mpvMesonOptions(device));
    expect(simulator.libplaceboMesonOptions).toEqual(device.libplaceboMesonOptions);
    expect(simulator.libraries).toEqual(device.libraries);
    expect(simulator.mpvRequiredFeatures).toEqual(device.mpvRequiredFeatures);
    const { APPLE_SDK: simulatorSdk, ...simulatorArgs } = dockerBuildArgs(simulator);
    const { APPLE_SDK: deviceSdk, ...deviceArgs } = dockerBuildArgs(device);
    console.info(
      `[media-deps:mobile] ${os} SDKs device=${deviceSdk} simulator=${simulatorSdk}; recipes device ${computeRecipeHash(device).slice(0, 12)} simulator ${computeRecipeHash(simulator).slice(0, 12)}`,
    );
    expect(simulatorArgs).toEqual(deviceArgs);
    // Separate bundles: the simulator never changes what the device bundle is.
    expect(computeRecipeHash(simulator)).not.toBe(computeRecipeHash(device));
  });
});

describe("licence labels of the mobile targets", () => {
  // A plain GPL licence (what ffmpeg / mpv carry for desktop). Dual licences with a permissive choice (freetype's
  // `FTL OR GPL-2.0-or-later`) and GPL with an exception for generated code (glslang's Bison parser) are fine.
  const gplOnly = (license: string) => /^GPL-[0-9.]+(-only|-or-later)?$/.test(license);

  it("label every mobile source LGPL-or-permissive in the bundle and source manifests, desktop stays GPL", async () => {
    const targets = await loadTargets();
    const mobile = targets.filter((target) => target.kind === "mobile");
    expect(mobile.map((target) => target.id)).toEqual(
      expect.arrayContaining(["android-arm64", "android-arm", "android-x64", "android-ia32", "ios-arm64", "tvos-arm64", "ios-arm64-simulator", "tvos-arm64-simulator"]),
    );
    for (const target of mobile) {
      const sources = targetSources(target);
      const records = buildSourcesManifest(target, "0".repeat(64)).sources.flatMap((record) => [record, ...(record.submodules ?? [])]);
      console.info(`[media-deps:mobile] ${target.id} licences: ${records.map((record) => `${record.id}=${record.license}`).join(" ")}`);
      expect(Object.entries(sources).filter(([, spec]) => gplOnly(spec.license))).toEqual([]);
      expect(records.filter((record) => gplOnly(record.license))).toEqual([]);
      for (const id of ["ffmpegmobile", "mpv", "mpvmobile"]) if (sources[id]) expect(sources[id]!.license).toBe("LGPL-2.1-or-later");
    }
    const macos = await loadDesktopTarget("macos-arm64");
    expect(targetSources(macos).ffmpeg?.license).toBe("GPL-2.0-or-later");
    expect(targetSources(macos).mpv?.license).toBe("GPL-2.0-or-later");
  });
});

describe("static mobile verifier parsers", () => {
  const binary = [
    "\0junk\0libavutil license: LGPL version 2.1 or later\0",
    "--prefix=/x --enable-shared --disable-everything --disable-programs --enable-decoder=h264\0",
    "List of enabled features: audiounit ffmpeg libass libmpv-shared libplacebo moltenvk vulkan zlib\0",
  ].join("");

  it("reads the licence, the configure line and the feature list out of a binary's bytes", () => {
    expect(embeddedFfmpegLicense(binary, "libavutil")).toBe("LGPL version 2.1 or later");
    expect(embeddedFfmpegConfiguration(binary)).toBe("--prefix=/x --enable-shared --disable-everything --disable-programs --enable-decoder=h264");
    expect(embeddedMpvFeatures(binary)).toContain("moltenvk");
  });

  it("flags a GPL or encoding FFmpeg build", () => {
    const problems = ffmpegConfigurationProblems("--enable-gpl --enable-libx264 --enable-encoder=aac --enable-muxer=mp4 --disable-everything");
    console.info(`[media-deps:mobile] problems: ${problems.join(", ")}`);
    expect(problems).toEqual([
      "licence_flag:--enable-gpl",
      "gpl_or_encoder_library:--enable-libx264",
      "not_playback:--enable-encoder=aac",
      "not_playback:--enable-muxer=mp4",
      "missing:--disable-programs",
    ]);
  });

  it("flags a missing required mpv feature and a GPL / player build", () => {
    expect(mpvFeatureProblems(["vulkan", "gpl", "cplayer"], ["vulkan", "moltenvk"])).toEqual(["missing:moltenvk", "forbidden:gpl", "forbidden:cplayer"]);
    expect(mpvFeatureProblems(["vulkan", "moltenvk"], ["vulkan", "moltenvk"])).toEqual([]);
  });
});
