import { describe, expect, it } from "vitest";
import { FFMPEG_COMPONENTS, MPV_FEATURES, ffmpegComponentFlags } from "../src/features";

/**
 * Regression pins carried over from the retired per-package build profiles
 * (packages/ffmpeg buildProfile `cpu-min` / `playback-shared-min`, packages/mpv
 * `linux-min-v1`). The one shared feature list now drives every OS, so each bug is pinned once.
 */
const flags = ffmpegComponentFlags();
const expectFlag = (flag: string) => {
  if (!flags.includes(flag)) console.error(`[media-deps:features] missing ${flag}; flags:\n${flags.join("\n")}`);
  expect(flags).toContain(flag);
};

describe("@bugfix @regression-proof shared ffmpeg feature list: playback", () => {
  it("covers the HLS playback path mpv uses", () => {
    for (const flag of [
      "--enable-demuxer=hls",
      "--enable-protocol=http",
      "--enable-decoder=h264",
      "--enable-decoder=hevc",
      "--enable-decoder=aac",
      "--enable-filter=aresample",
      "--enable-muxer=null",
    ]) {
      expectFlag(flag);
    }
  });

  // issue #25 / F4: the bundled mpv listed PGS tracks as "no subtitle tracks" because the build had no
  // `sup` demuxer and used the codec name `hdmv_pgs_subtitle` instead of the decoder component `pgssub`.
  it("demuxes raw .sup files (desktop hands PGS to mpv as a .sup sub-add)", () => {
    expectFlag("--enable-demuxer=sup");
  });

  it("decodes every bitmap subtitle codec the ingest extracts (pgs, dvdsub, dvbsub)", () => {
    for (const decoder of ["pgssub", "dvdsub", "dvbsub"]) expectFlag(`--enable-decoder=${decoder}`);
  });

  it("never passes a codec name where configure needs a component name", () => {
    const codecNames = ["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "mov_text"];
    const bad = flags.filter(
      (flag) => flag.startsWith("--enable-decoder=") && codecNames.includes(flag.split("=")[1] ?? ""),
    );
    expect(bad).toEqual([]);
  });

  // mpv's audio-signal readback (e2e-ultimate oscChecks readTone) adds `lavfi=[astats=...]`; bundle v4 had no
  // astats filter so every audio-signal check was "unsupported" (#25).
  it("enables the astats filter", () => {
    expectFlag("--enable-filter=astats");
    expect(MPV_FEATURES.requiredAudioFilters).toContain("astats");
  });
});

describe("@bugfix @regression-proof shared ffmpeg feature list: offline download mux", () => {
  // Offline MP4 downloads re-encode srt/webvtt subtitles with `-c:s mov_text`.
  it("encodes mov_text", () => {
    expectFlag("--enable-encoder=movtext");
  });
});

describe("@bugfix @regression-proof mpv converts frames with zimg", () => {
  // The app runs mpv with `--vo=x11`, which converts and scales every frame on the CPU. Without zimg it falls back to
  // libswscale: 26 ms per 1080p frame instead of 14 ms (#25 N3).
  it("enables zimg and asserts it is in the built mpv", () => {
    expect(MPV_FEATURES.mesonCommon.filter((option) => option.startsWith("-Dzimg="))).toEqual(["-Dzimg=enabled"]);
    expect(MPV_FEATURES.requiredFeatures).toContain("zimg");
  });

  it("builds mpv for the external-process policy only (no libmpv) with the product Lua", () => {
    expect(MPV_FEATURES.mesonCommon).toContain("-Dlibmpv=false");
    expect(MPV_FEATURES.mesonCommon).toContain("-Dlua=luajit");
  });
});
