/**
 * THE shared list of kept media features: one source of truth for the reduced
 * ffmpeg + ffprobe + mpv builds of EVERY desktop OS (linux-x64, windows-x64, and
 * macos-arm64 later). Nothing in here is OS specific; what one OS adds on top
 * (a hardware encoder API, a windowing backend) lives in that OS's recipe
 * (`recipes/<target>/target.ts`) and is asserted by `verifyTarget`.
 *
 * Every entry says WHY it is kept, so the next person can tell "the product uses
 * it" from "a user's file may need it". Add a component by adding its name to the
 * matching array; configure silently ignores unknown names, so `bun run verify`
 * (and the build itself) fails with `components_not_built` if a name is a typo.
 *
 * ONE ffmpeg build serves the CLI (ingest, previews, offline mux, encoder probes)
 * AND mpv's libav* (playback), so mpv can decode and demux everything the tool can.
 *
 * Bump FEATURE_LIST_VERSION whenever this list changes in a way a consumer
 * (installer, platform layer, tests) could notice. The recipe hash covers the
 * resolved flags, so any edit here rebuilds and republishes the bundles anyway.
 */
export const FEATURE_LIST_VERSION = 1;

export const FFMPEG_VERSION = "8.1.3";
export const MPV_VERSION = "0.41.0";
export const LIBPLACEBO_REF = "v7.360.0";

export type FfmpegComponentKind =
  | "protocol"
  | "demuxer"
  | "muxer"
  | "parser"
  | "decoder"
  | "encoder"
  | "bsf"
  | "filter"
  | "indev";

export const FFMPEG_COMPONENTS: Record<FfmpegComponentKind, readonly string[]> = {
  protocol: [
    "file", // every local read/write
    "pipe", // ingest streams the source through stdin (`-i pipe:0`)
    "concat", // `concat:` joins of fMP4 pieces
    "data", // inline data: URIs inside HLS/DASH init sections
    "http", // mpv pulls HLS from the local playback server
    "tcp",
    "crypto", // AES-128 HLS keys
  ],
  demuxer: [
    // Containers: playback (hls/mov/matroska) + user sources the ingest accepts (avi, wmv, ts, ps, ogg, flv-less).
    "hls",
    "mov", // mp4, m4a, mov, heic/avif
    "matroska", // mkv + webm
    "avi",
    "asf", // wmv, wma
    "mpegts",
    "mpegps",
    "mpegvideo", // mpegps probes its video PES with it: without it .mpg/.vob show no video and a phantom mp3 track
    "ogg", // ogg + opus
    "flv",
    "h264", // raw .h264 / .hevc elementary streams (mime table lists them)
    "hevc",
    "m4v",
    // Audio only
    "mp3",
    "aac",
    "ac3",
    "eac3",
    "dts",
    "dtshd",
    "truehd",
    "flac",
    "wav",
    "aiff",
    // Text + bitmap subtitle files
    "srt",
    "ass",
    "webvtt",
    "sup", // PGS arrives from ingest as a raw .sup
    // Stills: backdrop for mpv, image previews for ingest
    "image2",
    "image_jpeg_pipe",
    "image_png_pipe",
    "image_webp_pipe",
    "image_bmp_pipe",
    "gif",
    "rawvideo", // preview adapter feeds raw rgb24 (`-f rawvideo -i x.rgb`)
  ],
  muxer: [
    "dash", // ingest output
    "mp4", // dash segments, offline downloads
    "matroska", // offline downloads, bitmap subtitle extract
    "mov",
    "null", // encoder probes (`-f null -`), mpv's astats readback
    "image2", // previews, thumbnails, subtitle bitmaps
    "mp3", // audio-track samples (`-c:a libmp3lame out.mp3`)
    "srt",
    "sup",
    "webvtt",
    "rawvideo",
  ],
  parser: [
    "h264",
    "hevc",
    "aac",
    "aac_latm",
    "mpegaudio",
    "ac3",
    "dca",
    "flac",
    "vorbis",
    "opus",
    "vp8",
    "vp9",
    "av1",
    "mpeg4video",
    "mpegvideo",
    "vc1",
    "mjpeg",
    "png",
    "webp",
    "gif",
    "bmp",
    "dvdsub",
    "dvbsub",
  ],
  decoder: [
    "wrapped_avframe", // lavfi sources (the encoder probe's `-f lavfi -i color=…`) hand frames over wrapped
    // Video: what libraries realistically contain (ingest decodes them), plus our own output (h264/hevc).
    "h264",
    "hevc",
    "vp8",
    "vp9",
    "libdav1d", // AV1 (and .avif stills)
    "mpeg1video",
    "mpeg2video",
    "mpeg4",
    "msmpeg4v1",
    "msmpeg4v2",
    "msmpeg4v3",
    "wmv1",
    "wmv2",
    "wmv3",
    "vc1",
    "h263",
    "h263p",
    "mjpeg",
    "png",
    "webp",
    "gif",
    "bmp",
    "rawvideo",
    // Audio
    "aac",
    "aac_latm",
    "mp1",
    "mp2",
    "mp3",
    "ac3",
    "eac3",
    "dca",
    "truehd",
    "mlp",
    "flac",
    "vorbis",
    "opus",
    "alac",
    "wmav1",
    "wmav2",
    "wmapro",
    "pcm_s16le",
    "pcm_s16be",
    "pcm_s24le",
    "pcm_s24be",
    "pcm_s32le",
    "pcm_f32le",
    "pcm_u8",
    "adpcm_ms",
    "adpcm_ima_wav",
    // Subtitles: text + the bitmap formats the F3/F4 fixtures and PGS/VobSub sources need
    "subrip",
    "srt",
    "ass",
    "ssa",
    "webvtt",
    "movtext",
    "pgssub", // decoder name; its codec descriptor is hdmv_pgs_subtitle
    "dvdsub",
    "dvbsub",
  ],
  encoder: [
    // Video: CPU recipes (libx264 <=1080p, libx265 2160p). Hardware encoders are per OS (recipes).
    "wrapped_avframe", // `-f null` sinks: the encoder probe's default encoder
    "libx264",
    "libx265",
    // Audio
    "aac",
    "libmp3lame",
    // Stills + subtitle conversion
    "mjpeg",
    "png",
    "srt",
    "movtext", // offline MP4 mux re-encodes subs with `-c:s mov_text`
    "webvtt",
  ],
  bsf: ["h264_mp4toannexb", "hevc_mp4toannexb", "aac_adtstoasc", "extract_extradata"],
  filter: [
    // Transcode graphs
    "scale",
    "format",
    "null",
    "anull",
    "crop", // previews: squarePreviewFilter = scale + crop
    "overlay", // bitmap subtitle -> image extraction
    "color", // lavfi sources (encoder probe, subtitle canvases)
    "hwupload",
    "hwdownload",
    // Playback: mpv's audio-signal check (oscChecks readTone) rides lavfi=[astats]
    "aresample",
    "astats",
  ],
  indev: ["lavfi"],
};

/** External libraries every OS links statically into libavcodec (pkg-config names). */
export const FFMPEG_EXTERNAL_LIBS = ["libx264", "libx265", "libmp3lame", "libdav1d"] as const;

/**
 * Encoder families the product's transcode probe (`ffmpegCapabilities`) may pick. A target's
 * `hardwareEncoders` must list the subset its OS can really drive; the verifier requires
 * `h264_<family>` and `hevc_<family>` for every family a target lists.
 */
export type HardwareEncoderFamily = "vaapi" | "nvenc" | "qsv" | "amf" | "videotoolbox";

/** Software encoders every target must expose, regardless of OS. */
export const REQUIRED_SOFTWARE_ENCODERS = ["libx264", "libx265", "aac", "libmp3lame"] as const;

/** Hardware-assisted filters the transcode recipes build per family (kept when the family is). */
export const HARDWARE_FILTERS: Record<HardwareEncoderFamily, readonly string[]> = {
  vaapi: ["scale_vaapi"],
  nvenc: ["scale_cuda"],
  qsv: ["scale_qsv", "vpp_qsv"],
  amf: [],
  videotoolbox: [],
};

/**
 * mpv: what the player is expected to expose, identical on every OS. `mesonCommon` are the
 * OS-agnostic switches (non-product subsystems off); OS specifics (video/audio backends) are
 * in the recipe. `requiredFeatures` are asserted against `mpv -v --version`'s feature list.
 */
export const MPV_FEATURES = {
  /** mpv "List of enabled features" entries that must be present on every OS. */
  requiredFeatures: ["ffmpeg", "libass", "libplacebo", "luajit", "zimg", "zlib"] as readonly string[],
  /** `--vo=help` entries every OS must list (gpu-next/gpu are the product renderers). */
  requiredVideoOutputs: ["gpu", "gpu-next", "null"] as readonly string[],
  /** Video decoders resolved by mpv (`--vd=help`). pgssub/dvdsub are subtitle decoders: the ffmpeg component list covers them. */
  requiredDecoders: ["h264", "hevc", "mjpeg", "png", "webp"] as readonly string[],
  /** Audio filters (`--af=help`) the ultimate suite adds. */
  requiredAudioFilters: ["astats"] as readonly string[],
  mesonCommon: [
    "-Dcplayer=true",
    "-Dlibmpv=false", // external mpv only (policy): no embedded libmpv
    "-Dbuild-date=false",
    "-Dtests=false",
    "-Dfuzzers=false",
    "-Dmanpage-build=disabled",
    "-Dhtml-build=disabled",
    "-Dpdf-build=disabled",
    "-Djavascript=disabled",
    "-Djpeg=disabled",
    "-Dlcms2=disabled",
    "-Dcplugins=disabled",
    "-Dcdda=disabled",
    "-Ddvdnav=disabled",
    "-Dlibbluray=disabled",
    "-Ddvbin=disabled",
    "-Dvapoursynth=disabled",
    "-Djack=disabled",
    "-Dopenal=disabled",
    "-Dpipewire=disabled",
    "-Dsndio=disabled",
    "-Dsdl2-gamepad=disabled",
    "-Dsdl2-audio=disabled",
    "-Dsdl2-video=disabled",
    "-Dwayland=disabled",
    "-Ddmabuf-wayland=disabled",
    "-Dvulkan=disabled",
    "-Dcaca=disabled",
    "-Dsixel=disabled",
    "-Dlibarchive=disabled",
    "-Dlibavdevice=disabled",
    "-Duchardet=disabled",
    "-Drubberband=disabled",
    // The OSC (packages/mpv/resources/osc) is Lua: LuaJIT on every OS so the scripts see ONE Lua.
    "-Dlua=luajit",
    // --vo=x11 / software paths convert every frame on the CPU: zimg (SIMD, threaded) costs half
    // of libswscale (#25 N3).
    "-Dzimg=enabled",
  ],
} as const;

/**
 * THE shared configuration of every MOBILE and TV libmpv (REL-DEPS-11): Android, iPhone, Android TV / Fire TV,
 * Apple TV all build from this one object; a recipe adds only its platform's hardware decoding, audio output and
 * video output (`MobileDepsTarget`). Playback only: it plays every file type the desktop app plays (the desktop
 * list's containers, parsers and decoders, minus the few entries that only feed ingest/previews), and has NO
 * encoder, NO muxer, NO ffmpeg/ffprobe programs and NO GPL-only part, so the whole library is LGPL and can ship on
 * the App Store.
 */
export const DESKTOP_ONLY_DEMUXERS: readonly string[] = ["rawvideo"]; // the preview adapter's raw rgb24 input
export const DESKTOP_ONLY_DECODERS: readonly string[] = ["wrapped_avframe"]; // frames from lavfi sources (encoder probe)

export const MOBILE_FEATURES = {
  ffmpegComponents: {
    // Local files and the app's loopback HLS server (http://127.0.0.1, AES-128 keys, data: init URIs). No TLS.
    protocol: ["file", "http", "tcp", "crypto", "data"],
    demuxer: FFMPEG_COMPONENTS.demuxer.filter((name) => !DESKTOP_ONLY_DEMUXERS.includes(name)),
    muxer: [],
    parser: FFMPEG_COMPONENTS.parser,
    decoder: FFMPEG_COMPONENTS.decoder.filter((name) => !DESKTOP_ONLY_DECODERS.includes(name)),
    // None: mpv's screenshots (the only encoder user in a player) are dropped on mobile.
    encoder: [],
    // mpv's demuxer pulls codec extradata out of the stream; configure adds the bsfs a decoder selects by itself.
    bsf: ["extract_extradata"],
    // mpv's lavfi audio/video chains (format conversion, passthrough of the null graph).
    filter: ["aresample", "aformat", "format", "null", "anull"],
    indev: [],
  } satisfies Record<FfmpegComponentKind, readonly string[]>,
  /** External libraries linked statically into libavcodec: dav1d only (BSD-2-Clause). */
  ffmpegExternalLibs: ["libdav1d"] as readonly string[],
  /** ffmpeg configure flags of every mobile build. No `--enable-gpl` / `--enable-nonfree`: libav* stay LGPL-2.1+. */
  ffmpegBaseFlags: [
    "--disable-autodetect",
    "--disable-debug",
    "--disable-doc",
    "--disable-programs",
    "--disable-avdevice",
    "--disable-everything",
    "--enable-zlib",
  ] as readonly string[],
  /** mpv meson options of every mobile build: the embedded library only, LGPL, nothing a phone/TV player does not use. */
  mpvMesonCommon: [
    "-Dlibmpv=true",
    "-Dcplayer=false",
    "-Dgpl=false",
    "-Dbuild-date=false",
    "-Dtests=false",
    "-Dfuzzers=false",
    "-Dmanpage-build=disabled",
    "-Dhtml-build=disabled",
    "-Dpdf-build=disabled",
    // The app drives the player through the client API: no scripting, no OSC.
    "-Dlua=disabled",
    "-Djavascript=disabled",
    "-Dcplugins=disabled",
    // No screenshots (no encoder), no ICC profiles, no CPU scaler (the GPU renders).
    "-Djpeg=disabled",
    "-Dlcms2=disabled",
    "-Dzimg=disabled",
    "-Dcdda=disabled",
    "-Ddvdnav=disabled",
    "-Dlibbluray=disabled",
    "-Ddvbin=disabled",
    "-Dvapoursynth=disabled",
    "-Dlibarchive=disabled",
    "-Dlibavdevice=disabled",
    "-Duchardet=disabled",
    "-Drubberband=disabled",
    "-Djack=disabled",
    "-Dopenal=disabled",
    "-Dpipewire=disabled",
    "-Dpulse=disabled",
    "-Dalsa=disabled",
    "-Dsndio=disabled",
    "-Doss-audio=disabled",
    "-Dsdl2-gamepad=disabled",
    "-Dsdl2-audio=disabled",
    "-Dsdl2-video=disabled",
    "-Dx11=disabled",
    "-Dwayland=disabled",
    "-Ddmabuf-wayland=disabled",
    "-Ddrm=disabled",
    "-Dgbm=disabled",
    "-Dcaca=disabled",
    "-Dsixel=disabled",
  ] as readonly string[],
  /** mpv "List of enabled features" entries every mobile build must show (libmpv itself is not in that list: the
   * bundle check proves the library exists, `cplayer` below proves the program was not built). */
  mpvRequiredFeatures: ["ffmpeg", "libass", "libplacebo", "zlib"] as readonly string[],
  /** Entries a mobile build must NOT show: a GPL build, or the mpv program instead of the library. */
  mpvForbiddenFeatures: ["gpl", "cplayer"] as readonly string[],
} as const;

/** `--enable-<kind>=<name>` flags for a component list (default: the desktop list), in a stable order. */
export const ffmpegComponentFlags = (components: Record<FfmpegComponentKind, readonly string[]> = FFMPEG_COMPONENTS): string[] => {
  const flags: string[] = [];
  (Object.keys(components) as FfmpegComponentKind[]).forEach((kind) => {
    for (const name of components[kind]) flags.push(`--enable-${kind}=${name}`);
  });
  return flags;
};
