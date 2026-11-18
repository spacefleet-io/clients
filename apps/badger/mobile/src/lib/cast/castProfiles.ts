/**
 * What a cast target plays, from the vendors' PUBLISHED format lists (UX-TV-03). Nothing here was ever measured on a real
 * device (REL-TV-03 notes: casting is tested only against these lists).
 *
 * Sources, read 2026-10-20:
 * - Google Cast, "Supported Media for Google Cast" (https://developers.google.com/cast/docs/media, last updated
 *   2024-09-18 UTC): video codecs per device generation, audio codecs, WebVTT subtitles, HLS through the Web Receiver
 *   (the default media receiver plays HLS with fMP4 segments).
 * - Apple, "HLS Authoring Specification for Apple Devices": H.264 up to High Profile Level 5.2 (tvOS: 5.1), HEVC up to
 *   Main10 Level 5.1 in fMP4 with `hvc1` sample entries preferred over `hev1`, AAC / HE-AAC / AC-3 / E-AC-3 / FLAC /
 *   Apple Lossless audio, WebVTT subtitles.
 *
 * Pure: no React, no native.
 */

export type CastKind = "google-cast" | "airplay";

export type CastVideoLimits = {
  /** Highest H.264 level_idc the target lists (41 = level 4.1); null = H.264 not playable. */
  avcMaxLevel: number | null;
  /** HEVC allowed up to this level_idc (153 = level 5.1) and these profiles; null = HEVC not playable. */
  hevcMaxLevel: number | null;
  /** HEVC sample-entry tags accepted (`hvc1` / `hev1`). */
  hevcTags: readonly ("hvc1" | "hev1")[];
  vp9: boolean;
  av1: boolean;
  /** Tallest picture the target lists for its best codec (2160 = 4K). */
  maxHeight: number;
};

export type CastProfile = {
  id: string;
  kind: CastKind;
  /** Short log label. */
  label: string;
  video: CastVideoLimits;
  /** Audio codec families the target plays from an HLS fMP4 rendition; anything else is "cannot play". */
  audio: readonly AudioFamily[];
};

export type AudioFamily = "aac" | "mp3" | "opus" | "flac" | "alac" | "ac3" | "eac3" | "dts" | "truehd" | "vorbis" | "pcm";

/** The audio family of a stored track (`codec` label or RFC 6381 `codecString`), null when unknown. */
export const audioFamilyOf = (codec: string | null | undefined, codecString?: string | null): AudioFamily | null => {
  const text = `${codec ?? ""} ${codecString ?? ""}`.toLowerCase();
  if (!text.trim()) return null;
  if (/truehd|mlp|mlpa/.test(text)) return "truehd";
  if (/e-?ac-?3|ec-3|mp4a\.a6|ddp/.test(text)) return "eac3";
  if (/\bac-?3\b|mp4a\.a5/.test(text)) return "ac3";
  if (/dts|dca[a-z]|dtse|dtsh|dtsl|dtsx/.test(text)) return "dts";
  if (/aac|mp4a\.40|he-?aac/.test(text)) return "aac";
  if (/mp3|mp4a\.69|mp4a\.6b/.test(text)) return "mp3";
  if (/opus/.test(text)) return "opus";
  if (/flac/.test(text)) return "flac";
  if (/alac/.test(text)) return "alac";
  if (/vorbis/.test(text)) return "vorbis";
  if (/pcm|wav/.test(text)) return "pcm";
  return null;
};

/** H.264 `avc1.PPCCLL`: the level_idc (`LL`, hex) or null. */
export const avcLevelOf = (codecString: string | null | undefined): number | null => {
  const match = /^avc[13]\.[0-9a-f]{4}([0-9a-f]{2})/i.exec((codecString ?? "").trim());
  return match ? parseInt(match[1]!, 16) : null;
};

/** HEVC `hvc1.1.6.L153.B0`: the sample entry tag and level_idc (`L153` = 5.1), either may be null. */
export const hevcInfoOf = (codecString: string | null | undefined): { tag: "hvc1" | "hev1" | null; level: number | null } => {
  const text = (codecString ?? "").trim().toLowerCase();
  const tag = text.startsWith("hvc1") ? "hvc1" : text.startsWith("hev1") ? "hev1" : null;
  const level = /\.l(\d+)/.exec(text);
  return { tag, level: level ? parseInt(level[1]!, 10) : null };
};

const AAC_FAMILY: readonly AudioFamily[] = ["aac", "mp3", "opus", "flac", "vorbis", "pcm"];

/**
 * The model-name table of Google's list. `CastDevice.modelName` is what the Cast SDK reports; a Chromecast dongle reports
 * just "Chromecast" for the 1st, 2nd and 3rd generation, so that name gets the oldest list (no HEVC, level 4.1: Google
 * lists 4.1 for generations 1 and 2). A model we do not know gets that same oldest list: a refusal costs the user
 * "play it on the TV app", a stream the device cannot decode costs a black screen.
 */
const CAST_GENERIC: CastProfile = {
  id: "cast-chromecast",
  kind: "google-cast",
  label: "Chromecast (1st-3rd gen, or a model we do not know)",
  video: { avcMaxLevel: 41, hevcMaxLevel: null, hevcTags: [], vp9: false, av1: false, maxHeight: 1080 },
  audio: AAC_FAMILY,
};

const CAST_ULTRA: CastProfile = {
  id: "cast-ultra",
  kind: "google-cast",
  label: "Chromecast Ultra",
  video: { avcMaxLevel: 42, hevcMaxLevel: 153, hevcTags: ["hvc1", "hev1"], vp9: true, av1: false, maxHeight: 2160 },
  audio: AAC_FAMILY,
};

const CAST_GOOGLE_TV: CastProfile = {
  id: "cast-google-tv",
  kind: "google-cast",
  label: "Chromecast with Google TV",
  video: { avcMaxLevel: 51, hevcMaxLevel: 153, hevcTags: ["hvc1", "hev1"], vp9: true, av1: false, maxHeight: 2160 },
  audio: AAC_FAMILY,
};

const CAST_GOOGLE_TV_STREAMER: CastProfile = {
  id: "cast-google-tv-streamer",
  kind: "google-cast",
  label: "Google TV Streamer",
  video: { avcMaxLevel: 52, hevcMaxLevel: 153, hevcTags: ["hvc1", "hev1"], vp9: true, av1: true, maxHeight: 2160 },
  audio: AAC_FAMILY,
};

const CAST_NEST_HUB: CastProfile = {
  id: "cast-nest-hub",
  kind: "google-cast",
  label: "Google Nest Hub",
  video: { avcMaxLevel: 41, hevcMaxLevel: null, hevcTags: [], vp9: false, av1: false, maxHeight: 720 },
  audio: AAC_FAMILY,
};

/** Apple's list: the receiver is not named by AVRoutePickerView, so one list covers every AirPlay target. */
const AIRPLAY: CastProfile = {
  id: "airplay",
  kind: "airplay",
  label: "AirPlay",
  video: { avcMaxLevel: 51, hevcMaxLevel: 153, hevcTags: ["hvc1"], vp9: false, av1: false, maxHeight: 2160 },
  audio: ["aac", "ac3", "eac3", "alac", "flac"],
};

/** The profile for a Google Cast receiver by the model name the SDK reports (case-insensitive). */
export const castProfileForModel = (modelName: string | null | undefined): CastProfile => {
  const name = (modelName ?? "").trim().toLowerCase();
  if (name.includes("streamer")) return CAST_GOOGLE_TV_STREAMER;
  if (name.includes("ultra")) return CAST_ULTRA;
  if (name.includes("google tv")) return CAST_GOOGLE_TV;
  if (name.includes("nest hub")) return CAST_NEST_HUB;
  return CAST_GENERIC;
};

export const airPlayProfile = (): CastProfile => AIRPLAY;

export type VideoVerdict = { playable: true } | { playable: false; reason: string };

/**
 * Can the target play this stored video version? Judged on what the library stores for it: the codec label and
 * the RFC 6381 codec string (level, tag) and the quality label's height. A version with an unreadable codec string is
 * judged on its codec label alone for the codec family, and refused for H.264 / HEVC levels it cannot read, because
 * "unknown" is a black screen on the device.
 */
export const videoVerdict = (
  profile: CastProfile,
  video: { codec: string | null | undefined; codecString: string | null | undefined; height: number | null },
): VideoVerdict => {
  const label = (video.codec ?? "").toLowerCase();
  const text = (video.codecString ?? "").toLowerCase();
  const limits = profile.video;
  if (video.height != null && video.height > limits.maxHeight) {
    return { playable: false, reason: `height ${video.height} > ${limits.maxHeight}` };
  }
  const isHevc = /hevc|h\.?265|hvc1|hev1/.test(label) || /^(hvc1|hev1)/.test(text);
  const isAvc = !isHevc && (/h\.?264|avc/.test(label) || /^avc[13]/.test(text));
  if (isHevc) {
    if (limits.hevcMaxLevel == null) return { playable: false, reason: "HEVC not in the device's list" };
    const info = hevcInfoOf(video.codecString);
    if (info.tag && !limits.hevcTags.includes(info.tag)) return { playable: false, reason: `HEVC tag ${info.tag} not accepted` };
    if (info.level == null) return { playable: false, reason: "HEVC level unreadable" };
    if (info.level > limits.hevcMaxLevel) return { playable: false, reason: `HEVC level ${info.level} > ${limits.hevcMaxLevel}` };
    return { playable: true };
  }
  if (isAvc) {
    if (limits.avcMaxLevel == null) return { playable: false, reason: "H.264 not in the device's list" };
    const level = avcLevelOf(video.codecString);
    if (level == null) return { playable: false, reason: "H.264 level unreadable" };
    if (level > limits.avcMaxLevel) return { playable: false, reason: `H.264 level ${level} > ${limits.avcMaxLevel}` };
    return { playable: true };
  }
  if (/vp9|vp09/.test(label) || text.startsWith("vp09")) {
    return limits.vp9 ? { playable: true } : { playable: false, reason: "VP9 not in the device's list" };
  }
  if (/av1|av01/.test(label) || text.startsWith("av01")) {
    return limits.av1 ? { playable: true } : { playable: false, reason: "AV1 not in the device's list" };
  }
  return { playable: false, reason: `codec ${label || text || "unknown"} not in the device's list` };
};

export type AudioVerdict = "play" | "omit";

/**
 * Plays as stored, or is left out of the cast: nothing is converted (ingest stores every audio track as AAC, which every target
 * plays). An audio track whose codec we cannot name is "omit": the device is never handed a codec nobody checked.
 */
export const audioVerdict = (profile: CastProfile, track: { codec: string | null | undefined; codecString: string | null | undefined }): AudioVerdict => {
  const family = audioFamilyOf(track.codec, track.codecString);
  return family && profile.audio.includes(family) ? "play" : "omit";
};
