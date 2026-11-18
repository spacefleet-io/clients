// Wire-format types matching the badger-mobile ingest pipeline. Consumers
// fetch metadata from their own
// backend (e.g. via getMediaDetails()) and pass it into PlaybackBridge.startProxy.

export type VideoChunk = {
  key: string;
  sizeBytes: number;
  startSeconds: number;
  durationSeconds?: number;
};

export type VideoFormat = {
  id: string;
  quality: string;
  codec: string;
  codecString: string;
  initKey: string;
  initSize: number;
  durationSeconds: number;
  totalSize: number;
  bitrateKbps?: number;
  width?: number;
  height?: number;
  chunks: VideoChunk[];
};

export type AudioTrack = {
  id: string;
  language: string;
  label: string;
  isDefault: boolean;
  codec: string;
  codecString: string;
  initKey: string;
  initSize: number;
  durationSeconds: number;
  totalSize: number;
  chunks: VideoChunk[];
};

export type SubtitleTrack = {
  id: string;
  language: string;
  label: string;
  isDefault: boolean;
  /**
   * "vtt" = WebVTT text. "pgs" = HDMV PGS bitmap (decoded by libavcodec's hdmv_pgs_subtitle).
   * "vobsub" = DVD/VobSub bitmap stored in a matroska container (loaded sidecar via sub-add).
   */
  format: "vtt" | "pgs" | "vobsub";
  encrypted: boolean;
  /** Path under the storage backend — e.g. "subs-en/eng.vtt" or "subs-fr-pgs/fre.sup". */
  url: string;
  /**
   * OCR twin of a picture track (`pgs` / `vobsub`, PLAY-TRACK-05): the SRT the desktop runtime recognised from it
   * (`url` = its object key). Never a menu row of its own: `sidecarObjectKey` loads it in place of the picture while
   * mpv renders straight from the hardware decoder (Android TV `vo=mediacodec_embed`), which shows no pictures.
   * The native side ignores this field (only the picture track is part of the session).
   */
  ocrTwin?: { id: string; url: string } | null;
  /**
   * Where the library says the track came from (`media_subtitles.source`, e.g. a fetched subtitle's
   * `opensubtitles:<fileId>`), for the owner's own use ("Try another version", PLAY-SUBGET-07); never shown, and the
   * native side ignores it.
   */
  source?: string | null;
};

export type Chapter = {
  title: string;
  startSeconds: number;
  endSeconds: number;
};

export type IngestMetadata = {
  encryptionKeyBase64: string;
  /** Multiple video quality variants. PlaylistBuilder emits one EXT-X-STREAM-INF per entry. */
  videos: VideoFormat[];
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  /** Metadata-only — chapter markers for the seek bar UI. Not used by the proxy. */
  chapters: Chapter[];
};

/** Playback-state snapshot — `MpvControl.getPlaybackState` resolves with this. */
export type PlaybackState = {
  position: number;
  duration: number;
  paused: boolean;
  cacheEnd: number;
};

/** Richer snapshot from `MpvControl.getPlaybackSnapshot` (polled at 0.5-1 Hz, never per frame). */
export type PlaybackSnapshot = PlaybackState & {
  /**
   * Native monotonic clock (`SystemClock.elapsedRealtime`, ms) at the instant `position` was read. Judge media progress
   * against this, never against the JS time the snapshot was processed at (the JS thread can be seconds late).
   */
  sampledAtMs: number;
  cacheDuration: number;
  /** mpv `cache-speed`, bytes/s. */
  cacheSpeed: number;
  eof: boolean;
  pausedForCache: boolean;
  seeking: boolean;
  /** mpv `idle-active`: nothing loaded (before load, after a failed load). */
  idle: boolean;
  coreIdle: boolean;
  /** mpv `vo-configured`: true once the first video frame can be shown. */
  voConfigured: boolean;
  /** mpv `hwdec-current` ("mediacodec", "mediacodec-copy", "no", ""). */
  hwdec: string;
  /** mpv `current-vo` ("gpu", ...): the video output actually rendering, "" before the first frame. */
  currentVo: string;
  /** mpv `video-format` ("h264", "hevc", ...). */
  videoCodec: string;
  frameDrops: number;
  decoderFrameDrops: number;
  /** mpv `avsync`: audio/video difference in seconds (0 when unknown). */
  avsync: number;
  /**
   * Measured throughput of the proxy's upstream fetches in bits/s over the last ~15 s of fetching (0 = no recent
   * fetch). Unlike `cacheSpeed` it is not diluted by idle time while the cache is full.
   */
  netBps: number;
  /** Live mpv `cache-secs` / `demuxer-max-bytes` (0 = unavailable): what the demuxer cache can hold. */
  cacheSecs: number;
  demuxerMaxBytes: number;
  vid: number;
  aid: number;
  sid: number;
  videoWidth: number;
  videoHeight: number;
};

/** Track entry from `MpvControl.getTrackList` — decoded from libmpv's track-list JSON. */
export type MpvTrack = {
  id: number;
  type: "video" | "audio" | "sub" | string;
  selected: boolean;
  lang: string | null;
  title: string | null;
  codec?: string | null;
  demuxW?: number;
  demuxH?: number;
  /** HLS variant bandwidth (bits/s) when mpv exposes the video track as a variant; 0 otherwise. */
  hlsBitrate?: number;
  external?: boolean;
};

/** Seek mode flags accepted by `MpvControl.seek` / `MpvControl.seekRelative`. Pass-through to mpv. */
export type SeekMode =
  | "absolute"
  | "absolute+exact"
  | "absolute+keyframes"
  | "relative"
  | "relative+exact"
  | "relative+keyframes"
  | (string & {});

/** Best decoder of one kind (hardware or software) the device lists for a mime (`MediaCodecList(REGULAR_CODECS)`). */
export type DecoderLimits = {
  name: string;
  maxWidth: number;
  maxHeight: number;
  /** Frame rate the decoder supports at its maximum size; null when the device does not say. */
  maxFps: number | null;
  /** The decoder lists a 10-bit profile (HEVC Main10 / AVC High10). */
  tenBit: boolean;
};

export type CodecCaps = { mime: string; hardware: DecoderLimits | null; software: DecoderLimits | null };

/** The question asked of the device for one version: can you decode this size at this rate (and bit depth)? */
export type DecoderProbe = { id: string; mime: string; width: number; height: number; fps: number; tenBit: boolean };

/** The device's answer for one probe: `VideoCapabilities.areSizeAndRateSupported` over its hardware / software decoders. */
export type ProbeResult = { id: string; hardware: boolean; software: boolean };

export type DecoderCaps = {
  sdk: number;
  codecs: CodecCaps[];
  probes: ProbeResult[];
};
