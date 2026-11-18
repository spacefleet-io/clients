/**
 * iPhone decoder capabilities (PLAY-QUAL-06): iOS exposes no decoder limit table (no `MediaCodecList`), so the limits come
 * from Apple's published specifications for the model, keyed by the `utsname` machine id (`iPhone12,1` = iPhone 11).
 * Pure: no React, no native. The native side (`ios/Player/DecoderCaps.swift`) only reports the raw facts
 * (`IosDecoderReport`); `composeIosDecoderCaps` turns them into the same `DecoderCaps` shape Android returns, so the
 * start-quality code is identical on both phones.
 *
 * Sources (read 2026-10-20):
 * - Hardware HEVC (8-bit and 10-bit) decode from the A9: WWDC17 session 503 "Introducing HEIF and HEVC", slide
 *   "Hardware Decode - A9 Chip" / "10-bit Hardware Decode - A9 chip".
 *   https://devstreaming-cdn.apple.com/videos/wwdc/2017/503i6plfvfi7o3222/503/503_introducing_heif_and_hevc.pdf
 * - Frame rates: each model's Apple Tech Specs. Apple states the frame rate of 4K recording and playback of its own
 *   H.264/HEVC media on the same media engine, never a separate decode table; the ceiling used here is the highest 4K rate
 *   Apple publishes for the model (iPhone 6s: "H.264 video up to 4K, 30 frames per second", https://support.apple.com/kb/SP726;
 *   iPhone 7: 4K recording at 30 fps, SP743; iPhone 8 and later: HEVC 4K recording at 24/30/60 fps, SP767 ...
 *   https://support.apple.com/en-us/111829 (iPhone 15 Pro); iPhone 16 Pro, 17 Pro, 18 Pro: 4K Dolby Vision recording up to
 *   120 fps, https://support.apple.com/en-us/121031, https://www.apple.com/iphone-18-pro/specs/).
 * - H.264 stays at 4K 30 fps on every model: the only Apple figure for H.264 4K is the iPhone 6s's "up to 4K, 30 frames per
 *   second" (SP726). The Tech Specs of the iPhone 8 and later list "Video formats supported: HEVC, H.264, ..." with no frame
 *   rate, and no Apple page read (Tech Specs, https://support.apple.com/en-us/116944 on the "Most Compatible" = H.264 capture
 *   format) states H.264 at 4K 60 fps. Where Apple publishes nothing more, the lower figure is used.
 * - AV1 hardware decode: listed under "Video Playback - Supported formats" of iPhone 15 Pro / Pro Max, the iPhone 16, 16e,
 *   17, Air, 17e and 18 families (e.g. https://support.apple.com/en-us/111829, https://support.apple.com/en-us/121029,
 *   https://www.apple.com/iphone-17/specs/), and absent from iPhone 15 / 15 Plus and everything older
 *   (https://support.apple.com/en-us/111831). VP9 is listed nowhere: no iPhone is credited with a hardware VP9 decoder.
 *   Apple publishes no AV1 frame rate, so AV1 takes the lower figure, 4K at 30 fps, like H.264.
 * - Resolution: Apple documents "up to 4K" playback ("Up to 4K HDR AirPlay ..." in the same pages); 4096x2304 is the 4K
 *   picture H.264 level 5.2 / HEVC 4K decoders accept. 10-bit: Dolby Vision / HDR10 / HLG playback on every model since the
 *   iPhone 8 and the WWDC17 10-bit slide above; Apple's hardware H.264 decoder has no High10 support.
 * - Machine ids: https://support.apple.com/en-us/108044 for the models, https://theapplewiki.com/wiki/Models and
 *   https://appledb.dev for the identifiers (iPhone18,1 = iPhone 17 Pro, 18,2 = 17 Pro Max, 18,3 = iPhone 17, 18,4 = Air,
 *   18,5 = 17e, 19,2 = iPhone 18 Pro, 19,3 = iPhone 18 Pro Max).
 *
 * The deployment target is iOS 15.1 (iPhone 6s / SE 1st generation and later), so every generation from the A9 on has a row.
 * Each generation owns one major number (`iPhone<major>,<minor>`): 8 = A9, 9 = A10, 10 = A11, 11 = A12, 12 = A13,
 * 13 = A14, 14 = A15, 15 = A16, 16 = A17 Pro, 17 = A18 / A18 Pro, 18 = A19 / A19 Pro, 19 = A20.
 */
import type { CodecCaps, DecoderCaps, DecoderLimits, DecoderProbe, ProbeResult } from "./types";

export const IOS_MIME_AVC = "video/avc";
export const IOS_MIME_HEVC = "video/hevc";
export const IOS_MIME_VP9 = "video/x-vnd.on2.vp9";
export const IOS_MIME_AV1 = "video/av01";

/** What `DecoderCaps.report()` (Swift) returns: raw facts only, no limits. */
export type IosDecoderReport = {
  /** Major iOS version (`UIDevice.systemVersion`), like Android's `sdk`. */
  sdk: number;
  /** `utsname.machine`: `iPhone12,1` on a device, `arm64` / `x86_64` on a simulator. */
  machine: string;
  /** Built for the iOS simulator (`#if targetEnvironment(simulator)`). */
  simulator: boolean;
  /** `VTIsHardwareDecodeSupported(codec)` per mime. A `false` removes the codec from hardware whatever the table says. */
  videoToolbox: Record<string, boolean>;
};

export type CodecLimit = { maxWidth: number; maxHeight: number; maxFps: number; tenBit: boolean };

export type IosDecoderProfile = {
  /** The SoC the row stands for. */
  chip: string;
  h264: CodecLimit;
  hevc: CodecLimit;
  /** Null: no hardware AV1 decoder. */
  av1: CodecLimit | null;
};

const UHD_WIDTH = 4096;
const UHD_HEIGHT = 2304;

const uhd = (maxFps: number, tenBit: boolean): CodecLimit => ({ maxWidth: UHD_WIDTH, maxHeight: UHD_HEIGHT, maxFps, tenBit });

/** A9 / A10: 4K at 30 fps (iPhone 6s and 7 record and play 4K at 30 fps). */
const A9: IosDecoderProfile = { chip: "A9", h264: uhd(30, false), hevc: uhd(30, true), av1: null };
const A10: IosDecoderProfile = { chip: "A10", h264: uhd(30, false), hevc: uhd(30, true), av1: null };
/** A11 to A16: HEVC 4K at 60 fps; H.264 stays at 4K 30 fps (see the header: Apple publishes no H.264 4K60). */
const at60 = (chip: string): IosDecoderProfile => ({ chip, h264: uhd(30, false), hevc: uhd(60, true), av1: null });
/** A17 Pro and later: the same, plus the hardware AV1 decoder at 4K 30 fps (Apple publishes no AV1 frame rate). */
const at60Av1 = (chip: string): IosDecoderProfile => ({ ...at60(chip), av1: uhd(30, true) });

/** Generation by the major number of the machine id. */
const PROFILE_BY_MAJOR: Readonly<Record<number, IosDecoderProfile>> = {
  8: A9,
  9: A10,
  10: at60("A11"),
  11: at60("A12"),
  12: at60("A13"),
  13: at60("A14"),
  14: at60("A15"),
  15: at60("A16"),
  16: at60Av1("A17 Pro"),
  17: at60Av1("A18"),
  18: at60Av1("A19"),
  19: at60Av1("A20"),
};

/**
 * Models whose Tech Specs publish 4K at 120 fps (Dolby Vision HEVC): iPhone 16 Pro / Pro Max (17,1 / 17,2),
 * iPhone 17 Pro / Pro Max (18,1 / 18,2), iPhone 18 Pro / Pro Max (19,2 / 19,3). Only HEVC: the 120 fps figure is HEVC Dolby Vision.
 */
const HEVC_120_MODELS: Readonly<Record<string, true>> = {
  "iPhone17,1": true,
  "iPhone17,2": true,
  "iPhone18,1": true,
  "iPhone18,2": true,
  "iPhone19,2": true,
  "iPhone19,3": true,
};

const NEWEST_MAJOR = Math.max(...Object.keys(PROFILE_BY_MAJOR).map(Number));
const OLDEST_MAJOR = Math.min(...Object.keys(PROFILE_BY_MAJOR).map(Number));

/** The simulator, an iPad / Apple TV / Mac, or an iPhone older than iOS 15.1 allows: the oldest supported iPhone's limits. */
export const CONSERVATIVE_PROFILE: IosDecoderProfile = { ...A9, chip: "conservative" };

export type IosProfileSource =
  | "model" // a known machine id
  | "newest-known" // an iPhone newer than the table: the newest generation in it
  | "simulator" // conservative
  | "unlisted-device"; // not an iPhone (or an iPhone below the deployment target): conservative

export type IosProfileMatch = { profile: IosDecoderProfile; source: IosProfileSource; machine: string };

const IPHONE_ID = /^iPhone(\d+),(\d+)$/;

/** The limits for this machine: Apple's published ones for a known model, the newest known for a newer iPhone, conservative otherwise. */
export const iosDecoderProfile = (machine: string, simulator: boolean): IosProfileMatch => {
  if (simulator) return { profile: CONSERVATIVE_PROFILE, source: "simulator", machine };
  const match = IPHONE_ID.exec(machine.trim());
  if (!match) return { profile: CONSERVATIVE_PROFILE, source: "unlisted-device", machine };
  const major = Number(match[1]);
  if (major < OLDEST_MAJOR) return { profile: CONSERVATIVE_PROFILE, source: "unlisted-device", machine };
  const known = PROFILE_BY_MAJOR[Math.min(major, NEWEST_MAJOR)]!;
  const profile = Object.hasOwn(HEVC_120_MODELS, machine.trim()) ? { ...known, hevc: { ...known.hevc, maxFps: 120 } } : known;
  return { profile, source: major > NEWEST_MAJOR ? "newest-known" : "model", machine };
};

/** FFmpeg decodes any size and bit depth of these codecs; only CPU speed limits it and no API reports it (fps stays unknown). */
const SOFTWARE_MAX_WIDTH = 8192;
const SOFTWARE_MAX_HEIGHT = 4320;

type CodecRow = { mime: string; label: string; ffmpeg: string; limit: (profile: IosDecoderProfile) => CodecLimit | null };

const CODECS: readonly CodecRow[] = [
  { mime: IOS_MIME_AVC, label: "avc", ffmpeg: "h264", limit: (p) => p.h264 },
  { mime: IOS_MIME_HEVC, label: "hevc", ffmpeg: "hevc", limit: (p) => p.hevc },
  { mime: IOS_MIME_VP9, label: "vp9", ffmpeg: "vp9", limit: () => null },
  { mime: IOS_MIME_AV1, label: "av1", ffmpeg: "libdav1d", limit: (p) => p.av1 },
];

const hardwareLimit = (row: CodecRow, match: IosProfileMatch, report: IosDecoderReport): CodecLimit | null => {
  const limit = row.limit(match.profile);
  return limit && report.videoToolbox[row.mime] !== false ? limit : null;
};

const toLimits = (row: CodecRow, limit: CodecLimit | null): DecoderLimits | null =>
  limit ? { name: `videotoolbox-${row.label}`, maxWidth: limit.maxWidth, maxHeight: limit.maxHeight, maxFps: limit.maxFps, tenBit: limit.tenBit } : null;

/** The same `DecoderCaps` Android returns: per mime hardware / software limits, and the answer to each probe. */
export const composeIosDecoderCaps = (report: IosDecoderReport, probes: readonly DecoderProbe[]): DecoderCaps => {
  const match = iosDecoderProfile(report.machine, report.simulator);
  const hardware: Record<string, CodecLimit | null> = Object.fromEntries(CODECS.map((row) => [row.mime, hardwareLimit(row, match, report)]));
  const codecs: CodecCaps[] = CODECS.map((row) => ({
    mime: row.mime,
    hardware: toLimits(row, hardware[row.mime] ?? null),
    software: {
      name: `ffmpeg-${row.ffmpeg}`,
      maxWidth: SOFTWARE_MAX_WIDTH,
      maxHeight: SOFTWARE_MAX_HEIGHT,
      maxFps: null,
      tenBit: true,
    },
  }));
  const answers: ProbeResult[] = [];
  for (const probe of probes) {
    const known = CODECS.some((row) => row.mime === probe.mime);
    const limit = hardware[probe.mime] ?? null;
    const hardwareOk =
      limit !== null && probe.width <= limit.maxWidth && probe.height <= limit.maxHeight && probe.fps <= limit.maxFps && (!probe.tenBit || limit.tenBit);
    const softwareOk = known && probe.width <= SOFTWARE_MAX_WIDTH && probe.height <= SOFTWARE_MAX_HEIGHT;
    answers.push({ id: probe.id, hardware: hardwareOk, software: softwareOk });
  }
  return { sdk: report.sdk, codecs, probes: answers };
};

/** One log line: which row was chosen and why. */
export const describeIosProfile = (match: IosProfileMatch): string => {
  const limit = (name: string, value: CodecLimit | null) =>
    `${name}=${value ? `${value.maxWidth}x${value.maxHeight}@${value.maxFps}${value.tenBit ? "+10bit" : ""}` : "none"}`;
  const { profile } = match;
  return `machine=${match.machine} source=${match.source} chip=${profile.chip} ${limit("h264", profile.h264)} ${limit("hevc", profile.hevc)} ${limit("av1", profile.av1)}`;
};
