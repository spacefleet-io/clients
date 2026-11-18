/**
 * THE media format test set (REL-DEPS-11): one short fixture per container, video codec, audio codec and subtitle
 * format the mobile/TV libmpv keeps, derived from the shared feature list (`MOBILE_FEATURES`, `features.ts`). A phone
 * or TV build ships only after it plays every fixture on a real device of its platform.
 *
 * Two halves:
 *  - `MEDIA_TEST_SET`: per fixture, how to make it (`build`, TS only) and what playing it must show (`expect`). The
 *    generator (`scripts/generate-media-test-set.ts`) writes the files plus `expectations.json`, the
 *    language-neutral contract every device runner reads (Android: `MediaTestSetActivity`; iOS reuses the same file).
 *  - `MEDIA_TEST_SET_UNCOVERED`: the kept components no fixture exercises, each with the reason. The test
 *    `tests/mediaTestSet.test.ts` fails when a demuxer or decoder of the mobile list is neither covered nor listed here,
 *    so a component added to the feature list needs a fixture (or a stated reason) the same day.
 *
 * Every fixture is synthetic (ffmpeg lavfi sources, or the PGS writer in `syntheticMedia.ts`) except the few codecs
 * ffmpeg cannot encode (VC-1, WMV3, WMA Pro, MS-MPEG4v1, DTS-HD): those are fetched from the FFmpeg FATE sample suite
 * (https://fate-suite.ffmpeg.org, the samples FFmpeg's own regression tests use), pinned by sha256.
 */
import type { FfmpegComponentKind } from "./features";
import type { SyntheticPgsCue } from "./syntheticMedia";

export const MEDIA_TEST_SET_VERSION = 1;

/** Generation step. Paths are relative to the set directory. */
export type MediaTestStep =
  | { ffmpeg: string[] }
  | { text: { path: string; body: string } }
  | { pgs: { path: string; width: number; height: number; cues: SyntheticPgsCue[] } }
  | { fetch: { url: string; sha256: string; path: string } };

export type MediaTestVideo = {
  /** ffmpeg codec descriptor name, as mpv's `track-list/N/codec` reports it. */
  codec: string;
  width: number;
  height: number;
  /** The platform's hardware decoder (mediacodec / VideoToolbox) must decode it, not the software fallback. */
  platformHwdec?: boolean;
};

export type MediaTestAudio = { codec: string; channels: number; sampleRate: number };

export type MediaTestSubtitle = {
  codec: string;
  /** Loaded with `sub-add` (how the apps load every subtitle) instead of being a track of `file`. */
  sidecar?: string;
  /** Media time at which the cue is on screen. */
  atS: number;
  /** Text cues: `sub-text` at `atS` must contain it. Bitmap cues have none. */
  text?: string;
  bitmap: boolean;
};

export type MediaTestExpectation = {
  /** `file`: a local path. `hls`: an HTTP URL on the device's loopback, like the apps' playback proxy. */
  transport: "file" | "hls";
  /** Still image: one frame, no duration. */
  image?: boolean;
  video?: MediaTestVideo;
  audio?: MediaTestAudio;
  subtitle?: MediaTestSubtitle;
};

export type MediaTestFixture = {
  id: string;
  /** Played file (or HLS master playlist), relative to the set directory. */
  file: string;
  /** Kept ffmpeg components this fixture proves (component names, as in `features.ts`). */
  covers: Partial<Record<Extract<FfmpegComponentKind, "demuxer" | "decoder">, string[]>>;
  build: MediaTestStep[];
  expect: MediaTestExpectation;
};

/** What the generator adds from ffprobe: the measured duration and video frame count of the written file. */
export type MediaTestProbed = { durationS: number | null; frames: number | null; lavfFormat: string };

/** One entry of `expectations.json`. */
export type MediaTestExpectationEntry = Omit<MediaTestFixture, "build"> & { probed: MediaTestProbed; bytes: number };

export type MediaTestExpectationsFile = {
  version: number;
  generatedBy: string;
  fixtures: MediaTestExpectationEntry[];
  uncovered: Record<string, string>;
};

const SECONDS = 3;
const BITEXACT = ["-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact"];
const video = (w: number, h: number, rate = 24, seconds = SECONDS) => ["-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=${rate}:duration=${seconds}`];
const tone = (sampleRate = 48_000, seconds = SECONDS) => ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=${sampleRate}:duration=${seconds}`];
/** Video + tone in, `codecArgs` out to `path`. */
const av = (path: string, w: number, h: number, codecArgs: string[], opts: { rate?: number; sampleRate?: number; channels?: number } = {}): MediaTestStep => ({
  ffmpeg: [...video(w, h, opts.rate), ...tone(opts.sampleRate), ...codecArgs, "-ac", String(opts.channels ?? 2), ...BITEXACT, path],
});
const audioOnly = (path: string, codecArgs: string[], opts: { sampleRate?: number; channels?: number } = {}): MediaTestStep => ({
  ffmpeg: [...tone(opts.sampleRate), ...codecArgs, "-ac", String(opts.channels ?? 2), ...BITEXACT, path],
});
const videoOnly = (path: string, w: number, h: number, codecArgs: string[], rate = 24): MediaTestStep => ({ ffmpeg: [...video(w, h, rate), ...codecArgs, ...BITEXACT, path] });

const stereo = (codec: string, sampleRate = 48_000): MediaTestAudio => ({ codec, channels: 2, sampleRate });
const v = (codec: string, width = 320, height = 240): MediaTestVideo => ({ codec, width, height });
const fate = (path: string, sha256: string, to = path.split("/").pop()!): MediaTestStep => ({
  fetch: { url: `https://fate-suite.ffmpeg.org/${path}`, sha256, path: `fate/${to}` },
});

/** The subtitle fixtures share one 640x360 H.264 clip; the cue is on screen from 0.5 s to 2.5 s. */
const SUB_CLIP = "sub-clip.mp4";
const SUB_CLIP_STEP = av(SUB_CLIP, 640, 360, ["-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k"]);
const PGS_STEP: MediaTestStep = { pgs: { path: "sub-pgs.sup", width: 640, height: 360, cues: [{ startS: 0.5, endS: 2.5, x: 160, y: 270, w: 320, h: 60 }] } };
const SUB_AT = 1.5;
const SRT = "1\n00:00:00,500 --> 00:00:02,500\nSpaceBadger SRT\n";
const VTT = "WEBVTT\n\n00:00:00.500 --> 00:00:02.500\nSpaceBadger WebVTT\n";
const ASS = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "PlayResX: 640",
  "PlayResY: 360",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Sign,sans-serif,36,&H0000FFFF,&H000000FF,&H00800000,&H80000000,-1,-1,0,0,100,100,0,0,1,3,2,2,10,10,20,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:00.50,0:00:02.50,Sign,,0,0,0,,{\\c&H00FF00FF&\\b1}SpaceBadger{\\r} ASS {\\i1}styled{\\i0}",
].join("\n");

export const MEDIA_TEST_SET: readonly MediaTestFixture[] = [
  // --- Containers carrying the common pair (and the less common video codecs) ---------------------------------
  {
    id: "mp4-h264-aac",
    file: "mp4-h264-aac.mp4",
    covers: { demuxer: ["mov"], decoder: ["h264", "aac"] },
    build: [av("mp4-h264-aac.mp4", 320, 240, ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k"])],
    expect: { transport: "file", video: v("h264"), audio: stereo("aac") },
  },
  {
    id: "3gp-h263-aac",
    file: "3gp-h263-aac.3gp",
    covers: { demuxer: ["mov"], decoder: ["h263"] },
    build: [av("3gp-h263-aac.3gp", 176, 144, ["-c:v", "h263", "-c:a", "aac", "-b:a", "32k", "-ar", "22050"], { sampleRate: 22_050, channels: 1 })],
    expect: { transport: "file", video: v("h263", 176, 144), audio: { codec: "aac", channels: 1, sampleRate: 22_050 } },
  },
  {
    // H.263+ bitstream (h263p encoder): every container stores it as the h263 codec, decoded by the h263 decoder.
    id: "mov-h263plus-pcm_s24be",
    file: "mov-h263plus-pcm_s24be.mov",
    covers: { demuxer: ["mov"], decoder: ["h263", "pcm_s24be"] },
    build: [av("mov-h263plus-pcm_s24be.mov", 320, 240, ["-c:v", "h263p", "-c:a", "pcm_s24be"])],
    expect: { transport: "file", video: v("h263"), audio: stereo("pcm_s24be") },
  },
  {
    id: "mkv-hevc-eac3",
    file: "mkv-hevc-eac3.mkv",
    covers: { demuxer: ["matroska"], decoder: ["hevc", "eac3"] },
    build: [av("mkv-hevc-eac3.mkv", 320, 240, ["-c:v", "libx265", "-preset", "veryfast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p", "-c:a", "eac3", "-b:a", "96k"])],
    expect: { transport: "file", video: v("hevc"), audio: stereo("eac3") },
  },
  {
    id: "mkv-hevc10-2160p",
    file: "mkv-hevc10-2160p.mkv",
    covers: { demuxer: ["matroska"], decoder: ["hevc", "ac3"] },
    build: [
      av("mkv-hevc10-2160p.mkv", 3840, 2160, [
        "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-crf", "30", "-pix_fmt", "yuv420p10le", "-profile:v", "main10",
        "-c:a", "ac3", "-b:a", "192k",
      ]),
    ],
    expect: { transport: "file", video: { codec: "hevc", width: 3840, height: 2160, platformHwdec: true }, audio: stereo("ac3") },
  },
  {
    id: "mkv-av1-opus",
    file: "mkv-av1-opus.mkv",
    covers: { demuxer: ["matroska"], decoder: ["libdav1d", "opus"] },
    build: [av("mkv-av1-opus.mkv", 320, 240, ["-c:v", "libsvtav1", "-preset", "10", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "64k"])],
    expect: { transport: "file", video: v("av1"), audio: stereo("opus") },
  },
  {
    id: "webm-vp9-opus",
    file: "webm-vp9-opus.webm",
    covers: { demuxer: ["matroska"], decoder: ["vp9", "opus"] },
    build: [av("webm-vp9-opus.webm", 320, 240, ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-c:a", "libopus", "-b:a", "64k"])],
    expect: { transport: "file", video: v("vp9"), audio: stereo("opus") },
  },
  {
    id: "webm-vp8-vorbis",
    file: "webm-vp8-vorbis.webm",
    covers: { demuxer: ["matroska"], decoder: ["vp8", "vorbis"] },
    build: [av("webm-vp8-vorbis.webm", 320, 240, ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "300k", "-c:a", "libvorbis", "-q:a", "3"])],
    expect: { transport: "file", video: v("vp8"), audio: stereo("vorbis") },
  },
  {
    id: "avi-mpeg4-mp3",
    file: "avi-mpeg4-mp3.avi",
    covers: { demuxer: ["avi"], decoder: ["mpeg4", "mp3"] },
    build: [av("avi-mpeg4-mp3.avi", 320, 240, ["-c:v", "mpeg4", "-q:v", "5", "-c:a", "libmp3lame", "-b:a", "96k"])],
    expect: { transport: "file", video: v("mpeg4"), audio: stereo("mp3") },
  },
  {
    id: "avi-msmpeg4v2-pcm_u8",
    file: "avi-msmpeg4v2-pcm_u8.avi",
    covers: { demuxer: ["avi"], decoder: ["msmpeg4v2", "pcm_u8"] },
    build: [av("avi-msmpeg4v2-pcm_u8.avi", 320, 240, ["-c:v", "msmpeg4v2", "-q:v", "5", "-c:a", "pcm_u8", "-ar", "22050"], { sampleRate: 22_050, channels: 1 })],
    expect: { transport: "file", video: v("msmpeg4v2"), audio: { codec: "pcm_u8", channels: 1, sampleRate: 22_050 } },
  },
  {
    id: "avi-msmpeg4v3-adpcm_ms",
    file: "avi-msmpeg4v3-adpcm_ms.avi",
    covers: { demuxer: ["avi"], decoder: ["msmpeg4v3", "adpcm_ms"] },
    build: [av("avi-msmpeg4v3-adpcm_ms.avi", 320, 240, ["-c:v", "msmpeg4", "-q:v", "5", "-c:a", "adpcm_ms"])],
    expect: { transport: "file", video: v("msmpeg4v3"), audio: stereo("adpcm_ms") },
  },
  {
    id: "avi-mjpeg-adpcm_ima_wav",
    file: "avi-mjpeg-adpcm_ima_wav.avi",
    covers: { demuxer: ["avi"], decoder: ["mjpeg", "adpcm_ima_wav"] },
    build: [av("avi-mjpeg-adpcm_ima_wav.avi", 320, 240, ["-c:v", "mjpeg", "-q:v", "8", "-pix_fmt", "yuvj420p", "-c:a", "adpcm_ima_wav"])],
    expect: { transport: "file", video: v("mjpeg"), audio: stereo("adpcm_ima_wav") },
  },
  {
    id: "avi-rawvideo-pcm_s16le",
    file: "avi-rawvideo-pcm_s16le.avi",
    covers: { demuxer: ["avi"], decoder: ["rawvideo", "pcm_s16le"] },
    build: [av("avi-rawvideo-pcm_s16le.avi", 160, 120, ["-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le"], { rate: 12 })],
    expect: { transport: "file", video: v("rawvideo", 160, 120), audio: stereo("pcm_s16le") },
  },
  {
    id: "asf-wmv1-wmav1",
    file: "asf-wmv1-wmav1.wmv",
    covers: { demuxer: ["asf"], decoder: ["wmv1", "wmav1"] },
    build: [av("asf-wmv1-wmav1.wmv", 320, 240, ["-c:v", "wmv1", "-q:v", "5", "-c:a", "wmav1", "-b:a", "64k", "-ar", "44100"], { sampleRate: 44_100 })],
    expect: { transport: "file", video: v("wmv1"), audio: stereo("wmav1", 44_100) },
  },
  {
    id: "asf-wmv2-wmav2",
    file: "asf-wmv2-wmav2.wmv",
    covers: { demuxer: ["asf"], decoder: ["wmv2", "wmav2"] },
    build: [av("asf-wmv2-wmav2.wmv", 320, 240, ["-c:v", "wmv2", "-q:v", "5", "-c:a", "wmav2", "-b:a", "64k", "-ar", "44100"], { sampleRate: 44_100 })],
    expect: { transport: "file", video: v("wmv2"), audio: stereo("wmav2", 44_100) },
  },
  {
    id: "ts-h264-aac_latm",
    file: "ts-h264-aac_latm.ts",
    covers: { demuxer: ["mpegts"], decoder: ["h264", "aac_latm"] },
    build: [av("ts-h264-aac_latm.ts", 320, 240, ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-mpegts_flags", "latm"])],
    expect: { transport: "file", video: v("h264"), audio: stereo("aac_latm") },
  },
  {
    id: "mpg-mpeg1video-mp2",
    file: "mpg-mpeg1video-mp2.mpg",
    covers: { demuxer: ["mpegps", "mpegvideo"], decoder: ["mpeg1video", "mp2"] },
    build: [av("mpg-mpeg1video-mp2.mpg", 320, 240, ["-c:v", "mpeg1video", "-q:v", "5", "-c:a", "mp2", "-b:a", "128k", "-f", "mpeg"], { rate: 25 })],
    expect: { transport: "file", video: v("mpeg1video"), audio: stereo("mp2") },
  },
  {
    id: "vob-mpeg2video-ac3",
    file: "vob-mpeg2video-ac3.vob",
    covers: { demuxer: ["mpegps", "mpegvideo"], decoder: ["mpeg2video", "ac3"] },
    build: [av("vob-mpeg2video-ac3.vob", 720, 576, ["-c:v", "mpeg2video", "-q:v", "5", "-c:a", "ac3", "-b:a", "192k", "-f", "vob"], { rate: 25 })],
    expect: { transport: "file", video: v("mpeg2video", 720, 576), audio: stereo("ac3") },
  },
  {
    id: "flv-h264-aac",
    file: "flv-h264-aac.flv",
    covers: { demuxer: ["flv"], decoder: ["h264", "aac"] },
    build: [av("flv-h264-aac.flv", 320, 240, ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-ar", "44100"], { sampleRate: 44_100 })],
    expect: { transport: "file", video: v("h264"), audio: stereo("aac", 44_100) },
  },
  {
    id: "es-h264",
    file: "es-h264.h264",
    covers: { demuxer: ["h264"], decoder: ["h264"] },
    build: [videoOnly("es-h264.h264", 320, 240, ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-f", "h264"], 25)],
    expect: { transport: "file", video: v("h264") },
  },
  {
    id: "es-hevc",
    file: "es-hevc.hevc",
    covers: { demuxer: ["hevc"], decoder: ["hevc"] },
    build: [videoOnly("es-hevc.hevc", 320, 240, ["-c:v", "libx265", "-preset", "veryfast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p", "-f", "hevc"], 25)],
    expect: { transport: "file", video: v("hevc") },
  },
  {
    id: "es-m4v",
    file: "es-m4v.m4v",
    covers: { demuxer: ["m4v"], decoder: ["mpeg4"] },
    build: [videoOnly("es-m4v.m4v", 320, 240, ["-c:v", "mpeg4", "-q:v", "5", "-f", "m4v"], 25)],
    expect: { transport: "file", video: v("mpeg4") },
  },

  // --- Audio-only files ---------------------------------------------------------------------------------------
  { id: "mp3", file: "audio.mp3", covers: { demuxer: ["mp3"], decoder: ["mp3"] }, build: [audioOnly("audio.mp3", ["-c:a", "libmp3lame", "-b:a", "128k"])], expect: { transport: "file", audio: stereo("mp3") } },
  { id: "adts-aac", file: "audio.aac", covers: { demuxer: ["aac"], decoder: ["aac"] }, build: [audioOnly("audio.aac", ["-c:a", "aac", "-b:a", "128k", "-f", "adts"])], expect: { transport: "file", audio: stereo("aac") } },
  { id: "ac3", file: "audio.ac3", covers: { demuxer: ["ac3"], decoder: ["ac3"] }, build: [audioOnly("audio.ac3", ["-c:a", "ac3", "-b:a", "192k"])], expect: { transport: "file", audio: stereo("ac3") } },
  { id: "eac3", file: "audio.eac3", covers: { demuxer: ["eac3"], decoder: ["eac3"] }, build: [audioOnly("audio.eac3", ["-c:a", "eac3", "-b:a", "192k"])], expect: { transport: "file", audio: stereo("eac3") } },
  {
    id: "dts",
    file: "audio.dts",
    covers: { demuxer: ["dts"], decoder: ["dca"] },
    build: [audioOnly("audio.dts", ["-c:a", "dca", "-strict", "-2", "-b:a", "768k"])],
    expect: { transport: "file", audio: stereo("dts") },
  },
  {
    id: "truehd",
    file: "audio.thd",
    covers: { demuxer: ["truehd"], decoder: ["truehd"] },
    build: [audioOnly("audio.thd", ["-c:a", "truehd", "-strict", "-2", "-f", "truehd"])],
    expect: { transport: "file", audio: stereo("truehd") },
  },
  {
    id: "mka-mlp",
    file: "audio-mlp.mka",
    covers: { demuxer: ["matroska"], decoder: ["mlp"] },
    build: [audioOnly("audio-mlp.mka", ["-c:a", "mlp", "-strict", "-2"])],
    expect: { transport: "file", audio: stereo("mlp") },
  },
  { id: "flac", file: "audio.flac", covers: { demuxer: ["flac"], decoder: ["flac"] }, build: [audioOnly("audio.flac", ["-c:a", "flac"])], expect: { transport: "file", audio: stereo("flac") } },
  { id: "ogg-vorbis", file: "audio.ogg", covers: { demuxer: ["ogg"], decoder: ["vorbis"] }, build: [audioOnly("audio.ogg", ["-c:a", "libvorbis", "-q:a", "3"])], expect: { transport: "file", audio: stereo("vorbis") } },
  { id: "ogg-opus", file: "audio.opus", covers: { demuxer: ["ogg"], decoder: ["opus"] }, build: [audioOnly("audio.opus", ["-c:a", "libopus", "-b:a", "64k"])], expect: { transport: "file", audio: stereo("opus") } },
  { id: "m4a-alac", file: "audio-alac.m4a", covers: { demuxer: ["mov"], decoder: ["alac"] }, build: [audioOnly("audio-alac.m4a", ["-c:a", "alac"])], expect: { transport: "file", audio: stereo("alac") } },
  { id: "wav-pcm_s24le", file: "audio-s24le.wav", covers: { demuxer: ["wav"], decoder: ["pcm_s24le"] }, build: [audioOnly("audio-s24le.wav", ["-c:a", "pcm_s24le"])], expect: { transport: "file", audio: stereo("pcm_s24le") } },
  { id: "wav-pcm_s32le", file: "audio-s32le.wav", covers: { demuxer: ["wav"], decoder: ["pcm_s32le"] }, build: [audioOnly("audio-s32le.wav", ["-c:a", "pcm_s32le"])], expect: { transport: "file", audio: stereo("pcm_s32le") } },
  { id: "wav-pcm_f32le", file: "audio-f32le.wav", covers: { demuxer: ["wav"], decoder: ["pcm_f32le"] }, build: [audioOnly("audio-f32le.wav", ["-c:a", "pcm_f32le"])], expect: { transport: "file", audio: stereo("pcm_f32le") } },
  { id: "aiff-pcm_s16be", file: "audio.aiff", covers: { demuxer: ["aiff"], decoder: ["pcm_s16be"] }, build: [audioOnly("audio.aiff", ["-c:a", "pcm_s16be"])], expect: { transport: "file", audio: stereo("pcm_s16be") } },

  // --- Codecs ffmpeg cannot encode: FATE samples ---------------------------------------------------------------
  {
    id: "fate-vc1",
    file: "mkv-vc1.mkv",
    covers: { demuxer: ["matroska"], decoder: ["vc1"] },
    build: [
      fate("vc1/SA00040.vc1", "898035e63cfe0ddb1cc2c8749d7dafdfcc1b12fe5dac7e5b65941e6c4e41c860"),
      { ffmpeg: ["-r", "25", "-i", "fate/SA00040.vc1", "-c", "copy", ...BITEXACT, "mkv-vc1.mkv"] },
    ],
    expect: { transport: "file", video: v("vc1", 176, 144) },
  },
  {
    id: "fate-wmv3",
    file: "mkv-wmv3.mkv",
    covers: { demuxer: ["matroska"], decoder: ["wmv3"] },
    build: [
      fate("vc1/SMM0005.rcv", "2de6e6efe960bb0d93b0bfc0229e0b3b1fcdca72eb4b3e290de5f24fafa456f9"),
      { ffmpeg: ["-i", "fate/SMM0005.rcv", "-c", "copy", ...BITEXACT, "mkv-wmv3.mkv"] },
    ],
    expect: { transport: "file", video: v("wmv3", 720, 480) },
  },
  {
    id: "fate-wmapro",
    file: "fate/Beethovens_9th-1_small.wma",
    covers: { demuxer: ["asf"], decoder: ["wmapro"] },
    build: [fate("wmapro/Beethovens_9th-1_small.wma", "1d5a3b307d485ec47a6469591f3bc9900ff4576378695d3b777b0ea6f8d40665")],
    expect: { transport: "file", audio: stereo("wmapro") },
  },
  {
    id: "fate-msmpeg4v1",
    file: "fate/mpg4.avi",
    covers: { demuxer: ["avi"], decoder: ["msmpeg4v1"] },
    build: [fate("msmpeg4v1/mpg4.avi", "b410cdbb97c64f2ecf75ace0dc6a7fd941411283bc0972f7cc0cd745d4d3939a")],
    expect: { transport: "file", video: v("msmpeg4v1", 352, 240) },
  },
  {
    // 64 ms (three DTS frames): the suite's DTS-HD container samples are all this short.
    id: "fate-dtshd",
    file: "fate/core_51_24_48_768_0.dtshd",
    covers: { demuxer: ["dtshd"], decoder: ["dca"] },
    build: [fate("dts/dcadec-suite/core_51_24_48_768_0.dtshd", "95653e7d94307a9d467c28ae10883440dcc39f06ac79d7401b27eb422cd99009")],
    expect: { transport: "file", audio: { codec: "dts", channels: 6, sampleRate: 48_000 } },
  },

  // --- Subtitles: every format the apps hand to mpv -------------------------------------------------------------
  {
    id: "sub-srt",
    file: SUB_CLIP,
    covers: { demuxer: ["srt"], decoder: ["subrip"] },
    build: [SUB_CLIP_STEP, { text: { path: "sub.srt", body: SRT } }],
    expect: { transport: "file", video: v("h264", 640, 360), audio: stereo("aac"), subtitle: { codec: "subrip", sidecar: "sub.srt", atS: SUB_AT, text: "SpaceBadger SRT", bitmap: false } },
  },
  {
    id: "sub-ass-styled",
    file: SUB_CLIP,
    covers: { demuxer: ["ass"], decoder: ["ass"] },
    build: [SUB_CLIP_STEP, { text: { path: "sub.ass", body: ASS } }],
    expect: { transport: "file", video: v("h264", 640, 360), audio: stereo("aac"), subtitle: { codec: "ass", sidecar: "sub.ass", atS: SUB_AT, text: "SpaceBadger ASS styled", bitmap: false } },
  },
  {
    id: "sub-webvtt",
    file: SUB_CLIP,
    covers: { demuxer: ["webvtt"], decoder: ["webvtt"] },
    build: [SUB_CLIP_STEP, { text: { path: "sub.vtt", body: VTT } }],
    expect: { transport: "file", video: v("h264", 640, 360), audio: stereo("aac"), subtitle: { codec: "webvtt", sidecar: "sub.vtt", atS: SUB_AT, text: "SpaceBadger WebVTT", bitmap: false } },
  },
  {
    id: "sub-pgs",
    file: SUB_CLIP,
    covers: { demuxer: ["sup"], decoder: ["pgssub"] },
    build: [SUB_CLIP_STEP, PGS_STEP],
    expect: { transport: "file", video: v("h264", 640, 360), audio: stereo("aac"), subtitle: { codec: "hdmv_pgs_subtitle", sidecar: "sub-pgs.sup", atS: SUB_AT, bitmap: true } },
  },
  {
    // Ingest stores VobSub as a matroska file (packages/ingest-core/src/mediaProcessor.ts); the apps sub-add it.
    id: "sub-vobsub",
    file: SUB_CLIP,
    covers: { demuxer: ["matroska"], decoder: ["dvdsub"] },
    build: [SUB_CLIP_STEP, PGS_STEP, { ffmpeg: ["-i", "sub-pgs.sup", "-map", "0:s", "-c:s", "dvdsub", "-s", "640x360", ...BITEXACT, "sub-vobsub.mkv"] }],
    expect: { transport: "file", video: v("h264", 640, 360), audio: stereo("aac"), subtitle: { codec: "dvd_subtitle", sidecar: "sub-vobsub.mkv", atS: SUB_AT, bitmap: true } },
  },
  {
    id: "mp4-movtext",
    file: "mp4-movtext.mp4",
    covers: { demuxer: ["mov"], decoder: ["movtext"] },
    build: [
      { text: { path: "movtext.srt", body: SRT.replace("SRT", "mov_text") } },
      { ffmpeg: [...video(320, 240), "-i", "movtext.srt", "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:s", "mov_text", ...BITEXACT, "mp4-movtext.mp4"] },
    ],
    expect: { transport: "file", video: v("h264"), subtitle: { codec: "mov_text", atS: SUB_AT, text: "SpaceBadger mov_text", bitmap: false } },
  },
  {
    id: "ts-dvbsub",
    file: "ts-dvbsub.ts",
    covers: { demuxer: ["mpegts"], decoder: ["dvbsub"] },
    build: [
      PGS_STEP,
      { ffmpeg: [...video(640, 360, 25), "-i", "sub-pgs.sup", "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:s", "dvbsub", ...BITEXACT, "ts-dvbsub.ts"] },
    ],
    expect: { transport: "file", video: v("h264", 640, 360), subtitle: { codec: "dvb_subtitle", atS: SUB_AT, bitmap: true } },
  },

  // --- HLS fMP4 over loopback HTTP: the path every app playback takes (local playback proxy) ---------------------
  {
    id: "hls-fmp4-h264-aac",
    file: "hls-fmp4-h264-aac/master.m3u8",
    covers: { demuxer: ["hls", "mov"], decoder: ["h264", "aac"] },
    build: [
      av("hls-fmp4-h264-aac/index.m3u8", 640, 360, [
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-g", "24", "-c:a", "aac", "-b:a", "96k",
        "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4", "-master_pl_name", "master.m3u8",
        "-hls_segment_filename", "hls-fmp4-h264-aac/seg%d.m4s",
      ]),
    ],
    expect: { transport: "hls", video: v("h264", 640, 360), audio: stereo("aac") },
  },
  {
    // AES-128 segments exercise the crypto protocol; ffmpeg's hls muxer only encrypts MPEG-TS segments.
    id: "hls-ts-hevc-aes128",
    file: "hls-ts-hevc-aes128/master.m3u8",
    covers: { demuxer: ["hls", "mpegts"], decoder: ["hevc", "aac"] },
    build: [
      { text: { path: "hls-ts-hevc-aes128/key.bin", body: "0123456789abcdef" } },
      { text: { path: "hls-ts-hevc-aes128.keyinfo", body: "key.bin\nhls-ts-hevc-aes128/key.bin\n000102030405060708090a0b0c0d0e0f\n" } },
      av("hls-ts-hevc-aes128/index.m3u8", 640, 360, [
        "-c:v", "libx265", "-preset", "veryfast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p", "-g", "24",
        "-c:a", "aac", "-b:a", "96k",
        "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_type", "mpegts", "-master_pl_name", "master.m3u8",
        "-hls_key_info_file", "hls-ts-hevc-aes128.keyinfo", "-hls_segment_filename", "hls-ts-hevc-aes128/seg%d.ts",
      ]),
    ],
    expect: { transport: "hls", video: v("hevc", 640, 360), audio: stereo("aac") },
  },

  // --- Stills (backdrops, artwork) ------------------------------------------------------------------------------
  // lavf picks image2 when the path carries an image extension and the *_pipe demuxer otherwise; both ship.
  { id: "img-jpeg", file: "image.jpg", covers: { demuxer: ["image2", "image_jpeg_pipe"], decoder: ["mjpeg"] }, build: [{ ffmpeg: ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1", "-frames:v", "1", "-c:v", "mjpeg", "-pix_fmt", "yuvj420p", ...BITEXACT, "image.jpg"] }], expect: { transport: "file", image: true, video: v("mjpeg", 640, 360) } },
  { id: "img-png", file: "image.png", covers: { demuxer: ["image2", "image_png_pipe"], decoder: ["png"] }, build: [{ ffmpeg: ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1", "-frames:v", "1", "-c:v", "png", ...BITEXACT, "image.png"] }], expect: { transport: "file", image: true, video: v("png", 640, 360) } },
  { id: "img-webp", file: "image.webp", covers: { demuxer: ["image2", "image_webp_pipe"], decoder: ["webp"] }, build: [{ ffmpeg: ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=1", "-frames:v", "1", "-c:v", "libwebp", ...BITEXACT, "image.webp"] }], expect: { transport: "file", image: true, video: v("webp", 640, 360) } },
  { id: "img-bmp", file: "image.bmp", covers: { demuxer: ["image2", "image_bmp_pipe"], decoder: ["bmp"] }, build: [{ ffmpeg: ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1", "-frames:v", "1", "-c:v", "bmp", ...BITEXACT, "image.bmp"] }], expect: { transport: "file", image: true, video: v("bmp") } },
  {
    id: "img-gif-animated",
    file: "animated.gif",
    covers: { demuxer: ["gif"], decoder: ["gif"] },
    build: [{ ffmpeg: ["-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10:duration=2", "-c:v", "gif", ...BITEXACT, "animated.gif"] }],
    expect: { transport: "file", video: v("gif", 160, 120) },
  },
];

/** Kept components no fixture exercises, with the reason. Shrink this list; never grow it to make the test pass. */
export const MEDIA_TEST_SET_UNCOVERED: Readonly<Record<string, string>> = {
  "decoder:h263p":
    "lavf demuxes H.263+ from mov, avi and mkv to the h263 codec (fixture mov-h263plus-pcm_s24be plays such a stream through the h263 decoder); only RTP emits the h263p codec id",
  "decoder:mp1": "MPEG audio layer I: ffmpeg has no encoder and the FATE suite has no layer I sample",
  "decoder:srt": "legacy alias of subrip: lavf demuxes every .srt (and matroska S_TEXT/UTF8) to the subrip codec",
  "decoder:ssa": "legacy alias of ass: lavf demuxes .ssa and .ass to the ass codec",
};

/** The component keys (`kind:name`) a fixture list covers. */
export const coveredComponents = (fixtures: readonly MediaTestFixture[] = MEDIA_TEST_SET): Set<string> => {
  const keys = new Set<string>();
  for (const fixture of fixtures) {
    for (const [kind, names] of Object.entries(fixture.covers)) for (const name of names ?? []) keys.add(`${kind}:${name}`);
  }
  return keys;
};
