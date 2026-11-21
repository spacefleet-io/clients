import http from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import { stat } from "node:fs/promises";
import { URL } from "node:url";
import { dirname, isAbsolute, join as joinPath, relative as relativePath, resolve as resolvePath } from "node:path";
import {
  offlinePiecePath,
  readOfflinePieceManifest,
  type OfflinePieceTrack,
} from "@space/library-db-runtime/offlinePieceStore";
import { decryptMediaObject, isEncryptedPayload, readKeyFromEnv } from "./mediaCrypto";
import { downloadStorageObjectViaTunnelToSink } from "./api";
import { runWithRetries } from "./retry";
import { isSubscriptionUnpaidError, readSubscriptionUnpaidWipeAt } from "@space/shared/subscriptionUnpaid";
import { normalizeLanguageCode } from "@space/shared/trackPrefs";
import { scopeLogger } from "./logger";
import { createPlaybackThrottle, type PlaybackThrottle } from "./playbackThrottle";
import {
  createPlaybackLinkMeter,
  effectiveLinkEstimate,
  isMeteredHlsObject,
  type PlaybackLinkEstimate,
} from "./playbackLinkMeter";
import { runFullGc } from "./forceGc";
import { getDesktopPlatform } from "@space/desktop-platform";
import { createBurstTracker, limitPrefetchKeys, type Burst } from "./playbackTraffic";
import {
  StorageTunnelError,
  isFreePlaybackRefusedError,
  isPlaybackStoppedError,
  storageTrafficFromError,
  type StorageDownloadHints,
  type StorageTraffic,
  type StorageTrafficSnapshot,
} from "@space/shared/storageTunnel";
import { PLAYBACK_PROFILE_NOT_OWNED_CODE, PLAYBACK_PROFILE_REQUIRED_CODE } from "@space/shared/playbackProfile";
import { getActivePlaybackProfileId } from "./activePlaybackProfile";

/** STOR-BW-11: no profile picked, or one the server says is not the account's. A client bug: final, never retried. */
const isPlaybackProfileError = (error: unknown): error is StorageTunnelError =>
  error instanceof StorageTunnelError &&
  (error.code === PLAYBACK_PROFILE_REQUIRED_CODE || error.code === PLAYBACK_PROFILE_NOT_OWNED_CODE);

const NORMAL_TRAFFIC: StorageTrafficSnapshot = {
  state: "normal",
  playbackBufferSeconds: null,
  observedAt: 0,
};

/** What mpv is told when a tunnel fetch fails: 402 unpaid account, 503 refused or stopped playback (STOR-BW-07, STOR-BW-08), else 500. */
const playbackFailureStatus = (error: unknown): number => {
  if (isSubscriptionUnpaidError(error)) return 402;
  if (isFreePlaybackRefusedError(error) || isPlaybackStoppedError(error)) return 503;
  return 500;
};

const HLS_OBJECT_PREFETCH_COUNT = 4;
// Each prefetched object costs a tunnel session plus SHA-256 and AES-GCM in worker threads (#25).
const HLS_OBJECT_PREFETCH_MAX_IN_FLIGHT = 2;
// Upper bound on queued prefetch keys: one window per track kind (video + audio) with headroom.
const HLS_OBJECT_PREFETCH_QUEUE_MAX = HLS_OBJECT_PREFETCH_COUNT * 2;
const _HLS_OBJECT_PREFETCH_POOL_MULTIPLIER = 2; // prefetch = base * min(multiplier, poolCount)
// Video chunk cache cap (#25: low-end PCs). The cache is also emptied when mpv playback closes.
const OBJECT_PAYLOAD_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const STREAM_RELEASE_GRACE_MS = 30 * 1000;
const HLS_SESSION_RELEASE_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_RANGE_CAP_BYTES = 16 * 1024 * 1024;
const logger = scopeLogger("playback-server");

type PlaybackStreamChunk = {
  key: string;
  sizeBytes: number;
};

type PlaybackStreamRequest = {
  id?: string;
  initKey: string;
  initSize: number;
  chunks: PlaybackStreamChunk[];
  contentType: string;
};

type PlaybackStreamSegment = {
  key: string;
  size: number;
  start: number;
  end: number;
};

type PlaybackStream = {
  id: string;
  contentType: string;
  segments: PlaybackStreamSegment[];
  totalSize: number;
  createdAt: number;
  releasedAt?: number | null;
};

type PlaybackStreamResponse = {
  id: string;
  url: string;
  totalSize: number;
};

type HlsTrack = {
  initKey: string;
  codecString: string | null;
  segments: Array<{ key: string; durationSeconds: number; startSeconds?: number | null }>;
};

type HlsVideoVariant = {
  id: string;
  quality: string;
  bitrateKbps: number | null;
  width: number | null;
  height: number | null;
  track: HlsTrack;
};

type HlsAudioVariant = {
  id: string;
  language: string;
  label: string;
  isDefault: boolean;
  track: HlsTrack;
};

export type HlsSession = {
  id: string;
  mode: "vod" | "event";
  videos: HlsVideoVariant[];
  audio: HlsAudioVariant[];
  createdAt: number;
  releasedAt?: number | null;
};

type HlsKeyMetadata = {
  sessionId: string;
  kind: "video" | "audio";
  isInit: boolean;
  startSeconds: number | null;
  durationSeconds: number | null;
  /** Playing video variant's bitrate (bits/s), sent to the gateway as `playbackBps`; null for audio and inits. */
  bitrateBps?: number | null;
};

const shouldUseLocalObjects = () => process.env.SF_PLAYBACK_LOCAL_OBJECTS === "1";

const resolveLocalObjectsDir = () => {
  const explicit = process.env.SF_PLAYBACK_LOCAL_OBJECTS_DIR?.trim();
  const dummyRoot = process.env.SF_DUMMY_STORAGE_DIR?.trim();
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(isAbsolute(explicit) ? explicit : resolvePath(process.cwd(), explicit));
  }
  if (dummyRoot) {
    const resolved = isAbsolute(dummyRoot) ? dummyRoot : resolvePath(process.cwd(), dummyRoot);
    candidates.push(joinPath(resolved, "objects"));
  }
  candidates.push(joinPath(process.cwd(), ".storage", "objects"));
  candidates.push(joinPath(process.cwd(), "apps", "clients", "desktop", ".storage", "objects"));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] ?? joinPath(process.cwd(), ".storage", "objects");
};

const shouldDebugPlayback = () => process.env.SF_DEBUG_PLAYBACK_SERVER === "1";
const shouldDebugPlaybackTimings = () =>
  process.env.SF_DEBUG_PLAYBACK_TIMINGS === "1" || shouldDebugPlayback();
const resolvePlaybackLogFile = () => process.env.SF_PLAYBACK_LOG_FILE?.trim() || null;
const resolveRangeCap = () => {
  const fromEnv = Number(process.env.SF_PLAYBACK_RANGE_CAP_BYTES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_RANGE_CAP_BYTES;
};

const shouldForceRangeCap = () => process.env.SF_PLAYBACK_FORCE_RANGE_CAP === "1";

const resolveHlsObjectPrefetchCount = () => {
  const fromEnv = Number(process.env.SF_PLAYBACK_HLS_OBJECT_PREFETCH_COUNT);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return Math.floor(fromEnv);
  return HLS_OBJECT_PREFETCH_COUNT;
};

const resolveObjectPayloadCacheMaxBytes = () => {
  const fromEnv = Number(process.env.SF_PLAYBACK_OBJECT_CACHE_MAX_BYTES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return OBJECT_PAYLOAD_CACHE_MAX_BYTES;
};

const resolveObjectFetchRetryAttempts = () => {
  const fromEnv = Number(process.env.SF_PLAYBACK_OBJECT_FETCH_RETRY_ATTEMPTS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 3;
};

const resolveObjectFetchRetryDelayMs = () => {
  const fromEnv = Number(process.env.SF_PLAYBACK_OBJECT_FETCH_RETRY_DELAY_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return Math.floor(fromEnv);
  return 120;
};

const buildObjectUrl = (baseUrl: string, key: string) => {
  return `${baseUrl}/playback/object/${encodeURIComponent(key)}`;
};

const buildHlsHeader = (mode: "vod" | "event", targetDuration: number) => {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(targetDuration))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  if (mode === "event") {
    lines.push("#EXT-X-PLAYLIST-TYPE:EVENT");
  } else {
    lines.push("#EXT-X-PLAYLIST-TYPE:VOD");
  }
  return lines;
};

/**
 * P10 (#25): seconds every video segment boundary is announced EARLIER than
 * the segment's real first frame.
 *
 * FFmpeg's HLS demuxer (every release up to n9.0.2; fixed only on master by
 * 848fb754dd "don't discard target segment's first keyframe when seeking")
 * snaps a backward video seek to the EXTINF-derived start of the target
 * segment, then drops packets until a keyframe whose DTS is >= that start.
 * Our EXTINF timeline is PTS-based (DASH SegmentTimeline), and the demuxer's
 * baseline is the first packet it read (often audio, which starts ~21 ms
 * early from AAC priming), while the segment's opening keyframe carries a DTS
 * one B-frame reorder delay below its PTS (~83 ms for has_b_frames=2 @24 fps).
 * So that keyframe was discarded and any seek into the first GOP of a segment
 * (e.g. chapter 180 = 15 x 12 s) landed one GOP later (182.021).
 *
 * Announcing boundaries `lead` seconds early makes the opening keyframe pass
 * the demuxer's cutoff. It covers reorder delays up to ~6 frames @24 fps. The
 * price is that a seek landing in [boundary - lead, boundary) starts at the
 * boundary keyframe instead; mpv's `--hr-seek-demuxer-offset` (same value,
 * see @space/mpv external args) moves those demuxer targets into the previous
 * segment so hr-seek still lands exactly. Total duration is unchanged: the
 * last segment absorbs the lead.
 */
export const HLS_VIDEO_SEEK_LEAD_SECONDS = 0.25;

/**
 * EXTINF values for a track. Boundaries are accumulated in full precision and
 * rounded to ms BEFORE differencing, so per-segment `toFixed(3)` rounding can
 * no longer drift the demuxer's seek map over a long title. Boundaries after
 * the first are moved `leadSeconds` earlier (clamped to half the first
 * segment); the final end is not, so the playlist total stays exact.
 */
export const buildHlsExtinfDurations = (durations: readonly number[], leadSeconds: number): number[] => {
  if (durations.length === 0) return [];
  const lead = durations.length > 1 ? Math.max(0, Math.min(leadSeconds, durations[0] / 2)) : 0;
  const boundariesMs: number[] = [0];
  let cumulative = 0;
  durations.forEach((duration, index) => {
    cumulative += duration;
    const isEnd = index === durations.length - 1;
    boundariesMs.push(Math.round((isEnd ? cumulative : cumulative - lead) * 1000));
  });
  return durations.map((_, index) => (boundariesMs[index + 1] - boundariesMs[index]) / 1000);
};

const buildHlsTrackPlaylist = (
  track: HlsTrack,
  baseUrl: string,
  mode: "vod" | "event",
  kind: "video" | "audio",
) => {
  const durations = buildHlsExtinfDurations(
    track.segments.map((segment) => segment.durationSeconds),
    kind === "video" ? HLS_VIDEO_SEEK_LEAD_SECONDS : 0,
  );
  const targetDuration = durations.length > 0 ? Math.max(...durations) : 1;
  const lines = buildHlsHeader(mode, targetDuration);
  lines.push(`#EXT-X-MAP:URI="${buildObjectUrl(baseUrl, track.initKey)}"`);
  track.segments.forEach((segment, index) => {
    lines.push(`#EXTINF:${durations[index].toFixed(3)},`);
    lines.push(buildObjectUrl(baseUrl, segment.key));
  });
  if (mode === "vod") {
    lines.push("#EXT-X-ENDLIST");
  }
  return `${lines.join("\n")}\n`;
};

/**
 * PLAY-TRACK-04: each audio rendition carries the library's language as `LANGUAGE`. Without it mpv only sees the
 * fragment's own tag, which is `und` for a file whose audio language was set in the app (untagged at import), so
 * an OSC audio pick had no language to remember and the title's audio choice was never saved.
 */
export const buildMasterPlaylist = (session: HlsSession, baseUrl: string) => {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  const audioEntries = session.audio;
  const primaryAudio = audioEntries.find((entry) => entry.isDefault) ?? audioEntries[0] ?? null;
  const hasAudio = audioEntries.length > 0;
  const labelCounts = new Map<string, number>();
  audioEntries.forEach((entry) => {
    const key = (entry.label ?? "").trim().toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  });
  const seenLabelCounts = new Map<string, number>();
  audioEntries.forEach((entry) => {
    const audioUrl = `${baseUrl}/playback/hls/${session.id}/audio-${entry.id}.m3u8`;
    const baseLabel = (entry.label ?? "").trim() || "Audio";
    const normalizedKey = baseLabel.toLowerCase();
    const seenCount = (seenLabelCounts.get(normalizedKey) ?? 0) + 1;
    seenLabelCounts.set(normalizedKey, seenCount);
    const displayLabel =
      (labelCounts.get(normalizedKey) ?? 0) > 1 ? `${baseLabel} ${seenCount}` : baseLabel;
    const escapedDisplayLabel = displayLabel.replace(/"/g, '\\"');
    const language = normalizeLanguageCode(entry.language);
    const mediaAttrs = [
      "TYPE=AUDIO",
      'GROUP-ID="audio"',
      ...(language ? [`LANGUAGE="${language.replace(/"/g, "")}"`] : []),
      `NAME="${escapedDisplayLabel}"`,
      `DEFAULT=${entry.isDefault ? "YES" : "NO"}`,
      "AUTOSELECT=YES",
      `URI="${audioUrl}"`,
    ];
    lines.push(
      `#EXT-X-MEDIA:${mediaAttrs.join(",")}`
    );
  });
  session.videos.forEach((video) => {
    const codecString = [video.track.codecString, primaryAudio?.track.codecString]
      .filter(Boolean)
      .join(",");
    const bandwidth = Math.max(1, (video.bitrateKbps ?? 5000) * 1000);
    const resolution = video.width && video.height ? `,RESOLUTION=${video.width}x${video.height}` : "";
    const audioAttr = hasAudio ? ',AUDIO="audio"' : "";
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codecString}"${audioAttr}${resolution}`
    );
    lines.push(`${baseUrl}/playback/hls/${session.id}/video-${video.id}.m3u8`);
  });
  return `${lines.join("\n")}\n`;
};

const logPlayback = (event: string, details: Record<string, unknown>) => {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...details,
  };
  if (shouldDebugPlayback()) {
    logger.info(payload, "event");
  }
  const logFile = resolvePlaybackLogFile();
  if (logFile) {
    void fs.appendFile(logFile, `${JSON.stringify(payload)}\n`).catch(() => undefined);
  }
};

const isExpiredRelease = (stream: PlaybackStream, now: number) => {
  if (!stream.releasedAt) return false;
  return now - stream.releasedAt > STREAM_RELEASE_GRACE_MS;
};

const parseRangeHeader = (rangeHeader: string | undefined, totalSize: number) => {
  let start = 0;
  let end = totalSize - 1;
  if (!rangeHeader) {
    return { start, end, isRange: false };
  }
  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    return { start, end, isRange: false };
  }
  start = Number(match[1]);
  end = match[2] ? Number(match[2]) : end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return { start: 0, end: totalSize - 1, isRange: false, invalid: true };
  }
  if (start >= totalSize) {
    return { start, end, isRange: false, invalid: true };
  }
  if (end >= totalSize) {
    end = totalSize - 1;
  }
  return { start, end, isRange: true };
};

const computeRangeLength = (segments: PlaybackStreamSegment[], start: number, end: number) => {
  let totalLength = 0;
  for (const segment of segments) {
    if (segment.end < start) continue;
    if (segment.start > end) break;
    const sliceStart = Math.max(0, start - segment.start);
    const sliceEnd = Math.min(segment.size, end - segment.start + 1);
    totalLength += Math.max(0, sliceEnd - sliceStart);
  }
  return totalLength;
};

const buildStreamSegments = (request: PlaybackStreamRequest) => {
  const segments: PlaybackStreamSegment[] = [];
  const ensureSize = (size: number, label: string) => {
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`stream_invalid_size_${label}`);
    }
  };
  ensureSize(request.initSize, "init");
  let offset = 0;
  segments.push({
    key: request.initKey,
    size: request.initSize,
    start: 0,
    end: request.initSize - 1,
  });
  offset += request.initSize;
  request.chunks.forEach((chunk, index) => {
    ensureSize(chunk.sizeBytes, `chunk_${index}`);
    const start = offset;
    const end = start + chunk.sizeBytes - 1;
    segments.push({
      key: chunk.key,
      size: chunk.sizeBytes,
      start,
      end,
    });
    offset += chunk.sizeBytes;
  });
  return { segments, totalSize: offset };
};

const pipeFileToResponse = async (
  filePath: string,
  start: number,
  end: number,
  res: http.ServerResponse
) => {
  const stream = createReadStream(filePath, { start, end });
  try {
    for await (const chunk of stream) {
      if (res.destroyed || !res.writable) return;
      if (!res.write(chunk)) {
        await once(res, "drain");
        if (res.destroyed || !res.writable) return;
      }
    }
  } finally {
    stream.destroy();
  }
};

const isClientDisconnect = (req: http.IncomingMessage, res: http.ServerResponse, error: unknown) => {
  if (req.aborted || res.destroyed) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("aborted") ||
    error.message.includes("EPIPE") ||
    error.message.includes("ECONNRESET") ||
    error.message.includes("ERR_STREAM_DESTROYED")
  );
};

const writeBufferToResponse = async (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  payload: Buffer
) => {
  if (req.aborted || res.destroyed || !res.writable) return;
  await new Promise<void>((resolve) => {
    res.end(payload, () => {
      resolve();
    });
  });
};

type PlaybackServerHooks = {
  onSignedUrlRequest?: (increment: number) => void;
  onSignedUrlMetricsReset?: () => void;
  /**
   * The gateways' merged high-traffic state (STOR-BW-01), read on every look-ahead decision so the
   * window shrinks while high and is restored when normal. Omitted = always normal.
   */
  getTraffic?: () => StorageTrafficSnapshot;
  /** A playback source was opened (an HLS session, streamed or offline): what was known about the previous silo no longer applies. */
  onPlaybackStart?: () => void;
  /** The report of the silo that served a playback object: session open and every `session.ack` (STOR-BW-07, STOR-BW-08). */
  onPlaybackTraffic?: (traffic: StorageTraffic) => void;
  /** A saturated silo refused a new playback (STOR-BW-07). */
  onPlaybackRefused?: (traffic: StorageTraffic | null) => void;
  /** A saturated silo stopped this viewer's playback (STOR-BW-08). */
  onPlaybackStopped?: (traffic: StorageTraffic | null) => void;
  /** The server refused the profile named on the playback, or none was picked (STOR-BW-11): `profile_not_owned` / `profile_required`. */
  onPlaybackProfileRefused?: (code: string) => void;
};

/**
 * Resolve ALL plausible offline-downloads roots. The desktop main and the
 * client-managed runtime can disagree on the offline dir: main sets
 * SF_BADGER_OFFLINE_DIR=<userData>/offline for itself, but the runtime the
 * guardian spawns may not inherit it and falls back to its own default
 * ($SPACEFLEET_RUNTIME_DATA_DIR/offline, else the platform's runtime data dir + /offline).
 * A file is therefore legitimately under WHICHEVER root was active when the
 * runtime wrote it — so we accept a path under any candidate. Mirrors
 * apps/runtime/src/modules/index.ts resolveOfflineDir. @bugfix
 * offline-playback-ignored-local-file
 */
const resolveOfflineRoots = (): string[] => {
  const roots: string[] = [];
  const env = process.env.SF_BADGER_OFFLINE_DIR?.trim();
  if (env) roots.push(env);
  const { paths } = getDesktopPlatform();
  roots.push(joinPath(paths.runtimeDataDir(process.env), "offline"));
  // The runtime's default when no data-dir env is set — where downloads land if
  // the guardian spawned the runtime without forwarding the env. The pre-XDG
  // Linux default (/tmp/spacefleet-runtime) is deliberately NOT a root: /tmp is
  // shared with other users, and the migration copies its offline files into
  // this root.
  const defaultRoot = joinPath(paths.runtimeDataDir({ ...process.env, SPACEFLEET_RUNTIME_DATA_DIR: undefined }), "offline");
  if (!roots.includes(defaultRoot)) roots.push(defaultRoot);
  return roots;
};

/**
 * Containment guard: is `p` inside ANY recognized offline root? A
 * renderer-supplied path is only ever served when it passes this check —
 * defense-in-depth even though the path originates from the runtime's trusted
 * list_local. @bugfix offline-playback-ignored-local-file
 */
const isPathUnderOfflineRoot = (p: string): boolean => {
  if (!isAbsolute(p)) return false;
  const target = resolvePath(p);
  return resolveOfflineRoots().some((root) => {
    const rel = relativePath(resolvePath(root), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
};

/**
 * An offline piece track as an HLS track: segment durations from the next segment's start, the last one from the
 * track duration (same reading as the renderer's buildHlsTrackFromChunkMap for streaming).
 */
const hlsTrackFromOfflinePieces = (track: OfflinePieceTrack): HlsTrack => {
  const { chunks, durationSeconds } = track;
  const fallback = durationSeconds && chunks.length > 0 ? durationSeconds / chunks.length : 0;
  return {
    initKey: track.initKey,
    codecString: track.codecString,
    segments: chunks.map((chunk, index) => {
      const start = chunk.startSeconds ?? null;
      const next = chunks[index + 1]?.startSeconds ?? null;
      const duration =
        start !== null && next !== null
          ? next - start
          : start !== null && durationSeconds
            ? durationSeconds - start
            : fallback;
      return { key: chunk.key, durationSeconds: Math.max(0.001, duration), startSeconds: start };
    }),
  };
};

export class PlaybackServer {
  private server?: http.Server;
  private baseUrl?: string;
  private token: string | null = null;
  private signedUrlMetrics = { resetAt: Date.now(), requests: 0 };
  private streams = new Map<string, PlaybackStream>();
  private hlsSessions = new Map<string, HlsSession>();
  // Pieces saved offline on this device (OFFL-FILE-03), by object key → sealed file in the app's piece store.
  // Registered by createOfflineHlsSession; read before the tunnel, so a saved title never needs the network.
  private localPieces = new Map<string, string>();
  private hlsKeyIndex = new Map<string, HlsKeyMetadata>();
  private hlsObjectPrefetchKeys = new Map<string, string[]>();
  private objectPayloadCache = new Map<string, Buffer>();
  private objectPayloadCacheBytes = 0;
  // Bumped by clearObjectPayloadCache. A fetch or a prefetch window that began under an older
  // epoch belongs to a playback that closed: it must not refill the cache or schedule more work.
  private objectPayloadEpoch = 0;
  private objectPayloadPending = new Map<string, Promise<Buffer>>();
  private hlsPrefetchQueue: string[] = [];
  private hlsPrefetchInFlight = 0;
  private hooks: PlaybackServerHooks | null = null;
  // Initial rate from SF_PLAYBACK_THROTTLE_KBPS; tests change it at runtime via
  // setThrottleKbps (SF_PLAYBACK_THROTTLE_CONTROL=1 → globalThis.__sfPlaybackThrottle).
  // While the rate is 0 wrap is a pass-through, so production paths see zero overhead.
  private throttle: PlaybackThrottle = createPlaybackThrottle(
    process.env.SF_PLAYBACK_THROTTLE_KBPS,
  );
  // Upstream throughput over tunnel fetches of HLS video media segments: the link
  // Auto quality plans on (#25). Reset per HLS session.
  private linkMeter = createPlaybackLinkMeter();
  // Classifies foreground fetches as a playback `start` or a `seek` for the gateway scheduler.
  private burstTracker = createBurstTracker();

  constructor(hooks?: PlaybackServerHooks) {
    this.hooks = hooks ?? null;
  }

  /** Test throttle on the mpv-facing responses, in kbps; 0 turns it off. */
  setThrottleKbps(kbps: number) {
    const previousKbps = this.throttle.kbps();
    this.throttle.setKbps(kbps);
    logPlayback("throttle.set", { previousKbps, kbps, estimate: this.getLinkEstimate() });
  }

  getThrottleKbps(): number {
    return this.throttle.kbps();
  }

  getLinkEstimate(): PlaybackLinkEstimate {
    return effectiveLinkEstimate(this.linkMeter.snapshot(), this.throttle.kbps());
  }

  async start(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    const bindHost = process.env.SF_PLAYBACK_BIND_HOST?.trim() || "127.0.0.1";
    const publicHost = process.env.SF_PLAYBACK_PUBLIC_HOST?.trim() || bindHost;
    this.server = http.createServer((req, res) => void this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        reject(new Error("playback_server_missing"));
        return;
      }
      const onError = (error: Error) => {
        this.server?.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, bindHost);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("playback_server_bind_failed");
    }
    this.baseUrl = `http://${publicHost}:${address.port}`;
    return this.baseUrl;
  }

  getBaseUrl() {
    return this.baseUrl ?? null;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.hlsPrefetchQueue = [];
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = undefined;
    this.baseUrl = undefined;
  }

  /**
   * Mpv playback closed (user closed mpv, playback ended, renderer stop): free every cached
   * chunk Buffer and the byte counter, and drop the queued prefetch keys. Downloads still in
   * flight finish for their callers but are not stored (epoch), and a foreground request that
   * was already waiting does not schedule a new prefetch window.
   */
  clearObjectPayloadCache(reason: string) {
    this.objectPayloadEpoch += 1;
    const bytesBefore = this.objectPayloadCacheBytes;
    const entriesBefore = this.objectPayloadCache.size;
    const queuedBefore = this.hlsPrefetchQueue.length;
    this.objectPayloadCache.clear();
    this.objectPayloadCacheBytes = 0;
    this.hlsPrefetchQueue = [];
    this.burstTracker.reset();
    logPlayback("object.cache.cleared", {
      reason,
      bytesBefore,
      entriesBefore,
      queuedBefore,
      inFlightPrefetches: this.hlsPrefetchInFlight,
      pendingFetches: this.objectPayloadPending.size,
      bytesAfter: this.objectPayloadCacheBytes,
    });
    // Nothing was held (e.g. the renderer's stop right after mpv's exit): nothing to give back.
    if (bytesBefore === 0) return;
    try {
      const { ms } = runFullGc();
      logPlayback("object.cache.gc", { reason, freedBytesRequested: bytesBefore, gcMs: ms });
    } catch (error) {
      logPlayback("object.cache.gc_failed", { reason, error: error instanceof Error ? error.message : String(error) });
    }
  }

  getObjectPayloadCacheStats() {
    return {
      bytes: this.objectPayloadCacheBytes,
      entries: this.objectPayloadCache.size,
      maxBytes: resolveObjectPayloadCacheMaxBytes(),
      queuedPrefetchKeys: this.hlsPrefetchQueue.length,
    };
  }

  setToken(token: string | null) {
    this.token = token;
  }

  resetSignedUrlMetrics() {
    this.signedUrlMetrics = { resetAt: Date.now(), requests: 0 };
    this.hooks?.onSignedUrlMetricsReset?.();
  }

  getSignedUrlMetrics() {
    return { ...this.signedUrlMetrics };
  }

  createHlsSession(payload: {
    id?: string;
    mode?: "vod" | "event";
    videos: HlsVideoVariant[];
    audio: HlsAudioVariant[];
  }) {
    if (!this.baseUrl) {
      throw new Error("playback_server_not_ready");
    }
    const explicitId = typeof payload.id === "string" && payload.id.trim().length > 0 ? payload.id.trim() : null;
    const id = explicitId ?? randomUUID();
    if (this.hlsSessions.has(id)) {
      throw new Error("hls_session_exists");
    }
    const session: HlsSession = {
      id,
      mode: payload.mode ?? "vod",
      videos: payload.videos,
      audio: payload.audio,
      createdAt: Date.now(),
    };
    this.hlsSessions.set(id, session);
    this.registerHlsKeys(session);
    // A new session is a new file or a reload: its estimate starts from scratch.
    logPlayback("link.meter.reset", { sessionId: id, previous: this.linkMeter.snapshot() });
    this.linkMeter.reset();
    this.burstTracker.reset();
    this.hooks?.onPlaybackStart?.();
    logPlayback("hls.session.created", {
      id,
      videoTracks: session.videos.length,
      audioTracks: session.audio.length,
      videoSegments: session.videos.reduce((sum, video) => sum + video.track.segments.length, 0),
      audioSegments: session.audio.reduce((sum, audio) => sum + audio.track.segments.length, 0),
    });
    return { id, url: `${this.baseUrl}/playback/hls/${id}/master.m3u8` };
  }

  releaseHlsSession(id: string) {
    const session = this.hlsSessions.get(id);
    if (!session) return;
    session.releasedAt = Date.now();
    logPlayback("hls.session.released", { id });
  }

  /**
   * Pre-warm the chunk cache for a session at a specific time offset.
   *
   * Pre-fix mpv was launched on a freshly-created HLS session with no
   * chunks staged. mpv requested master/playlists/init/segment-N on a
   * cold proxy: each request triggered an on-demand storage tunnel fetch
   * (~50–500 ms per object). When the user changed default audio/sub
   * right before launch AND was resuming partway through a file, mpv
   * arrived at the resume position before the proxy had staged the
   * segment-at-that-offset. mpv's HLS demuxer treats a slow first
   * segment as a stream error and (with `--keep-open=yes`) seeks back
   * to the playlist start and retries — the audible 3–10 s segment
   * loop.
   *
   * Warming the chunks the user is about to need BEFORE launching mpv
   * collapses that window: the proxy's object cache holds the init
   * segments and the segment at the resume offset, so mpv's first
   * read latency is microseconds instead of hundreds of ms. The
   * existing `prefetchHlsObjects` chain (line 1039) handles the next
   * few segments organically once mpv starts requesting.
   *
   * Awaits all fetches so the renderer can show a "loading" UI for
   * the duration of the prewarm and only call `launchExternalMpv`
   * after this resolves.
   *
   * @bugfix mpv-launch-loop-cold-hls-proxy
   */
  async prewarmHlsSession(
    id: string,
    options: { videoId?: string | null; audioId?: string | null; startSeconds?: number | null },
  ): Promise<{
    warmedKeys: string[];
    missedKeys: string[];
    elapsedMs: number;
  }> {
    const startMs = Date.now();
    const session = this.hlsSessions.get(id);
    if (!session) {
      logPlayback("hls.prewarm.session_missing", { id });
      return { warmedKeys: [], missedKeys: [], elapsedMs: 0 };
    }
    const startSeconds = typeof options.startSeconds === "number" && Number.isFinite(options.startSeconds)
      ? Math.max(0, options.startSeconds)
      : 0;
    const pickVideo = () => {
      if (options.videoId) {
        const match = session.videos.find((v) => v.id === options.videoId);
        if (match) return match;
      }
      return session.videos[0] ?? null;
    };
    const pickAudio = () => {
      if (options.audioId) {
        const match = session.audio.find((a) => a.id === options.audioId);
        if (match) return match;
      }
      return session.audio.find((a) => a.isDefault) ?? session.audio[0] ?? null;
    };
    const findSegmentAtTime = (
      segments: ReadonlyArray<{ key: string; startSeconds?: number | null; durationSeconds?: number | null }>,
      seconds: number,
    ) => {
      if (segments.length === 0) return null;
      for (const segment of segments) {
        const start = segment.startSeconds ?? null;
        const duration = segment.durationSeconds ?? null;
        if (start === null) continue;
        const end = duration !== null ? start + duration : Number.POSITIVE_INFINITY;
        if (seconds >= start && seconds < end) {
          return segment;
        }
      }
      // Fall back to the closest segment by startSeconds.
      const indexed = segments
        .map((s) => ({ s, start: s.startSeconds ?? null }))
        .filter((entry): entry is { s: typeof segments[number]; start: number } => entry.start !== null);
      if (indexed.length === 0) return segments[0] ?? null;
      indexed.sort((a, b) => Math.abs(a.start - seconds) - Math.abs(b.start - seconds));
      return indexed[0].s;
    };
    const targets: Array<{ key: string; kind: string }> = [];
    const video = pickVideo();
    if (video) {
      if (video.track.initKey) targets.push({ key: video.track.initKey, kind: "video-init" });
      const seg = findSegmentAtTime(video.track.segments, startSeconds);
      if (seg?.key) targets.push({ key: seg.key, kind: "video-segment" });
    }
    const audio = pickAudio();
    if (audio) {
      if (audio.track.initKey) targets.push({ key: audio.track.initKey, kind: "audio-init" });
      const seg = findSegmentAtTime(audio.track.segments, startSeconds);
      if (seg?.key) targets.push({ key: seg.key, kind: "audio-segment" });
    }
    logPlayback("hls.prewarm.begin", {
      id,
      startSeconds,
      videoId: video?.id ?? null,
      audioId: audio?.id ?? null,
      targets: targets.map((t) => ({ key: t.key, kind: t.kind })),
    });
    const warmedKeys: string[] = [];
    const missedKeys: string[] = [];
    await Promise.all(
      targets.map(async ({ key, kind }) => {
        try {
          await this.getObjectPayload(key, this.burstTracker.note(this.hlsKeyIndex.get(key)));
          warmedKeys.push(key);
        } catch (error) {
          missedKeys.push(key);
          logPlayback("hls.prewarm.miss", {
            id,
            key,
            kind,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    const elapsedMs = Date.now() - startMs;
    logPlayback("hls.prewarm.done", {
      id,
      warmed: warmedKeys.length,
      missed: missedKeys.length,
      elapsedMs,
    });
    return { warmedKeys, missedKeys, elapsedMs };
  }

  private pruneHlsSessions() {
    const now = Date.now();
    for (const [id, session] of this.hlsSessions.entries()) {
      if (!session.releasedAt) continue;
      if (now - session.releasedAt > HLS_SESSION_RELEASE_GRACE_MS) {
        this.hlsSessions.delete(id);
        this.dropHlsKeys(id);
        logPlayback("hls.session.pruned", { id });
      }
    }
  }

  private registerHlsKeys(session: HlsSession) {
    const addKey = (key: string | null | undefined, meta: Omit<HlsKeyMetadata, "sessionId">) => {
      if (!key) return;
      this.hlsKeyIndex.set(key, { sessionId: session.id, ...meta });
    };
    const prefetchCount = resolveHlsObjectPrefetchCount();
    session.videos.forEach((video) => {
      addKey(video.track.initKey, {
        kind: "video",
        isInit: true,
        startSeconds: null,
        durationSeconds: null,
      });
      if (video.track.initKey && video.track.segments[0]?.key && prefetchCount > 0) {
        this.hlsObjectPrefetchKeys.set(video.track.initKey, [video.track.segments[0].key]);
      }
      video.track.segments.forEach((segment) => {
        addKey(segment.key, {
          kind: "video",
          isInit: false,
          startSeconds: segment.startSeconds ?? null,
          durationSeconds: segment.durationSeconds ?? null,
          bitrateBps: video.bitrateKbps ? Math.round(video.bitrateKbps * 1000) : null,
        });
      });
      video.track.segments.forEach((segment, index) => {
        if (prefetchCount <= 0) return;
        const nextKeys = video.track.segments
          .slice(index + 1, index + 1 + prefetchCount)
          .map((entry) => entry.key);
        if (nextKeys.length > 0) {
          this.hlsObjectPrefetchKeys.set(segment.key, nextKeys);
        }
      });
    });
    session.audio.forEach((audio) => {
      addKey(audio.track.initKey, {
        kind: "audio",
        isInit: true,
        startSeconds: null,
        durationSeconds: null,
      });
      if (audio.track.initKey && audio.track.segments[0]?.key && prefetchCount > 0) {
        this.hlsObjectPrefetchKeys.set(audio.track.initKey, [audio.track.segments[0].key]);
      }
      audio.track.segments.forEach((segment) => {
        addKey(segment.key, {
          kind: "audio",
          isInit: false,
          startSeconds: segment.startSeconds ?? null,
          durationSeconds: segment.durationSeconds ?? null,
        });
      });
      audio.track.segments.forEach((segment, index) => {
        if (prefetchCount <= 0) return;
        const nextKeys = audio.track.segments
          .slice(index + 1, index + 1 + prefetchCount)
          .map((entry) => entry.key);
        if (nextKeys.length > 0) {
          this.hlsObjectPrefetchKeys.set(segment.key, nextKeys);
        }
      });
    });
  }

  private dropHlsKeys(sessionId: string) {
    for (const [key, meta] of this.hlsKeyIndex.entries()) {
      if (meta.sessionId === sessionId) {
        this.hlsKeyIndex.delete(key);
        this.hlsObjectPrefetchKeys.delete(key);
      }
    }
    this.hlsPrefetchQueue = this.hlsPrefetchQueue.filter((key) => this.hlsKeyIndex.has(key));
  }

  createStream(request: PlaybackStreamRequest): PlaybackStreamResponse {
    if (!this.baseUrl) {
      throw new Error("playback_server_not_ready");
    }
    this.pruneStreams();
    const { segments, totalSize } = buildStreamSegments(request);
    const explicitId = typeof request.id === "string" && request.id.trim().length > 0 ? request.id.trim() : null;
    const id = explicitId ?? randomUUID();
    if (this.streams.has(id)) {
      throw new Error("playback_stream_exists");
    }
    this.streams.set(id, {
      id,
      contentType: request.contentType,
      segments,
      totalSize,
      createdAt: Date.now(),
    });
    logPlayback("stream.created", {
      id,
      contentType: request.contentType,
      segments: segments.length,
      totalSize,
    });
    return {
      id,
      url: `${this.baseUrl}/playback/stream/${encodeURIComponent(id)}`,
      totalSize,
    };
  }

  releaseStream(id: string) {
    const stream = this.streams.get(id);
    if (!stream) return;
    stream.releasedAt = Date.now();
    this.streams.set(id, stream);
    logPlayback("stream.released", { id });
  }

  /**
   * Offline playback (OFFL-FILE-03): an HLS session built from a saved item's manifest, the same path as streaming.
   * Every piece the manifest lists (video, audio tracks, subtitles) is registered as local, so `/playback/object/<key>`
   * serves it from the app's private store (decrypted here, Range honoured) with no tunnel and no token: playback works
   * with the server unreachable. The manifest path comes from the runtime's list_local and must sit in an offline root.
   */
  async createOfflineHlsSession(payload: { fileId: string; manifestPath: string; id?: string }) {
    if (!this.baseUrl) {
      throw new Error("playback_server_not_ready");
    }
    const fileId = typeof payload?.fileId === "string" ? payload.fileId.trim() : "";
    const manifestPath = typeof payload?.manifestPath === "string" ? payload.manifestPath.trim() : "";
    if (!fileId || !manifestPath) {
      throw new Error("offline_session_invalid_payload");
    }
    if (!isPathUnderOfflineRoot(manifestPath)) {
      logPlayback("offline.path_rejected", { fileId, offlineRoots: resolveOfflineRoots() });
      throw new Error("offline_path_outside_root");
    }
    let manifest;
    try {
      manifest = await readOfflinePieceManifest(manifestPath);
    } catch (error) {
      logPlayback("offline.manifest_unreadable", {
        fileId,
        manifestPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error("offline_file_missing");
    }
    if (manifest.fileId !== fileId) {
      logPlayback("offline.manifest_mismatch", { fileId, manifestFileId: manifest.fileId });
      throw new Error("offline_file_missing");
    }
    // <root>/items/<sha>.json → the pieces live in <root>/objects/.
    const root = dirname(dirname(manifestPath));
    for (const object of manifest.objects) {
      this.localPieces.set(object.key, offlinePiecePath(root, object.key));
    }
    const session = this.createHlsSession({
      ...(payload.id ? { id: payload.id } : {}),
      videos: [
        {
          id: manifest.video.id,
          quality: manifest.video.quality,
          bitrateKbps: manifest.video.bitrateKbps,
          width: null,
          height: null,
          track: hlsTrackFromOfflinePieces(manifest.video.track),
        },
      ],
      audio: manifest.audio.map((audio) => ({
        id: audio.id,
        language: audio.language,
        label: audio.label,
        isDefault: audio.isDefault,
        track: hlsTrackFromOfflinePieces(audio.track),
      })),
    });
    logPlayback("offline.hls.created", {
      id: session.id,
      fileId,
      quality: manifest.video.quality,
      audioTracks: manifest.audio.length,
      subtitles: manifest.subtitles.length,
      pieces: manifest.objects.length,
    });
    // The subtitles saved with the item: the renderer offers only these (their object URLs serve the local pieces).
    return { ...session, subtitleKeys: manifest.subtitles.map((sub) => sub.objectKey) };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin ?? "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname.startsWith("/playback/hls/")) {
      await this.handleHlsRequest(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/playback/stream/")) {
      await this.handleStreamRequest(req, res, url);
      return;
    }
    if (!url.pathname.startsWith("/playback/object/")) {
      res.writeHead(404).end("not_found");
      return;
    }
    const key = decodeURIComponent(url.pathname.replace("/playback/object/", ""));
    if (!key) {
      res.writeHead(400).end("key_missing");
      return;
    }
    // A piece saved offline on this device is served with no token (offline playback works logged out / unreachable);
    // the listener binds to 127.0.0.1 and serves only pieces of items the user saved here.
    if (!this.token && !this.localPieces.has(key)) {
      res.writeHead(401).end("token_missing");
      return;
    }
    const hlsMeta = this.hlsKeyIndex.get(key);
    logPlayback("object.request", {
      key,
      range: req.headers.range ?? null,
      hls: hlsMeta
        ? {
            sessionId: hlsMeta.sessionId,
            kind: hlsMeta.kind,
            isInit: hlsMeta.isInit,
            startSeconds: hlsMeta.startSeconds,
            durationSeconds: hlsMeta.durationSeconds,
          }
        : null,
    });
    const localOnly = shouldUseLocalObjects();
    if (localOnly) {
      const localObjectsDir = resolveLocalObjectsDir();
      const localPath = joinPath(localObjectsDir, key);
      if (existsSync(localPath)) {
        try {
          const fileStat = await stat(localPath);
          const totalSize = fileStat.size;
          const header = Buffer.alloc(4);
          const handle = await fs.open(localPath, "r");
          try {
            await handle.read(header, 0, header.length, 0);
          } finally {
            await handle.close();
          }
          const encrypted = isEncryptedPayload(header);
          if (!encrypted) {
            const { start, end, isRange, invalid } = parseRangeHeader(req.headers.range, totalSize);
            if (invalid) {
              res.writeHead(416).end("range_invalid");
              return;
            }
            const rangeStart = start;
            const rangeEnd = end;
            const headers: Record<string, string> = {
              "Accept-Ranges": "bytes",
              "Content-Length": String(rangeEnd - rangeStart + 1),
              "Content-Type": "application/octet-stream",
            };
            if (isRange) {
              headers["Content-Range"] = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
              res.writeHead(206, headers);
            } else {
              res.writeHead(200, headers);
            }
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            this.throttle.wrap(res);
            await pipeFileToResponse(localPath, rangeStart, rangeEnd, res);
            if (!res.writableEnded) {
              res.end();
            }
            return;
          }

          if (!readKeyFromEnv()) {
            logPlayback("object.error", { key, error: "media_key_missing" });
            res.writeHead(500).end("media_key_missing");
            return;
          }
          const raw = await fs.readFile(localPath);
          const { plaintext } = await decryptMediaObject(raw);
          const decodedSize = plaintext.length;
          const { start, end, isRange, invalid } = parseRangeHeader(req.headers.range, decodedSize);
          if (invalid) {
            res.writeHead(416).end("range_invalid");
            return;
          }
          const rangeStart = start;
          const rangeEnd = end;
          const headers: Record<string, string> = {
            "Accept-Ranges": "bytes",
            "Content-Length": String(rangeEnd - rangeStart + 1),
            "Content-Type": "application/octet-stream",
          };
          if (isRange) {
            headers["Content-Range"] = `bytes ${rangeStart}-${rangeEnd}/${decodedSize}`;
            res.writeHead(206, headers);
          } else {
            res.writeHead(200, headers);
          }
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          this.throttle.wrap(res);
          await writeBufferToResponse(req, res, plaintext.subarray(rangeStart, rangeEnd + 1));
          return;
        } catch (error) {
          if (isClientDisconnect(req, res, error)) {
            return;
          }
          const message = error instanceof Error ? error.message : "local_fetch_failed";
          logPlayback("object.error", { key, error: message });
          res.writeHead(500).end(message);
          return;
        }
      }
      res.writeHead(404).end("local_object_missing");
      return;
    }
    try {
      const epoch = this.objectPayloadEpoch;
      const payload = await this.getObjectPayload(key, this.burstTracker.note(this.hlsKeyIndex.get(key)));
      // Start prefetch immediately so next HLS segments warm up while we stream this response.
      // Not when mpv playback closed while this request waited: nothing is left to play.
      if (epoch === this.objectPayloadEpoch) {
        this.prefetchHlsObjects(key);
      }
      const totalSize = payload.length;
      const { start, end, isRange, invalid } = parseRangeHeader(req.headers.range, totalSize);
      if (invalid) {
        res.writeHead(416).end("range_invalid");
        return;
      }
      const rangeStart = start;
      const rangeEnd = end;
      const headers: Record<string, string> = {
        "Accept-Ranges": "bytes",
        "Content-Length": String(rangeEnd - rangeStart + 1),
        "Content-Type": "application/octet-stream",
      };
      if (isRange) {
        headers["Content-Range"] = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
        res.writeHead(206, headers);
      } else {
        res.writeHead(200, headers);
      }
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      this.throttle.wrap(res);
      await writeBufferToResponse(req, res, payload.subarray(rangeStart, rangeEnd + 1));
    } catch (error) {
      if (isClientDisconnect(req, res, error)) {
        return;
      }
      const message = error instanceof Error ? error.message : "playback_failed";
      logPlayback("object.error", { key, error: message });
      res.writeHead(playbackFailureStatus(error)).end(message);
    }
  }

  private async handleHlsRequest(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ) {
    this.pruneHlsSessions();
    const parts = url.pathname.split("/").filter(Boolean);
    const sessionId = parts[2] ?? null;
    const file = parts[3] ?? "";
    const session = sessionId ? this.hlsSessions.get(sessionId) : null;
    if (!session) {
      logPlayback("hls.session.missing", { sessionId, file });
      res.writeHead(404).end("hls_session_missing");
      return;
    }
    const baseUrl = this.getBaseUrl();
    if (file === "master.m3u8") {
    logPlayback("hls.request", { sessionId, file });
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(buildMasterPlaylist(session, baseUrl ?? ""));
      return;
    }
    if (file.startsWith("video-") && file.endsWith(".m3u8")) {
      const videoId = file.slice("video-".length, -".m3u8".length);
      const video = session.videos.find((entry) => entry.id === videoId);
      if (!video) {
        logPlayback("hls.request.missing", { sessionId, file, kind: "video" });
        res.writeHead(404).end("hls_track_missing");
        return;
      }
      logPlayback("hls.request", { sessionId, file });
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(buildHlsTrackPlaylist(video.track, baseUrl ?? "", session.mode, "video"));
      return;
    }
    if (file.startsWith("audio-") && file.endsWith(".m3u8")) {
      const audioId = file.slice("audio-".length, -".m3u8".length);
      const audio = session.audio.find((entry) => entry.id === audioId);
      if (!audio) {
        logPlayback("hls.request.missing", { sessionId, file, kind: "audio" });
        res.writeHead(404).end("hls_track_missing");
        return;
      }
      logPlayback("hls.request", { sessionId, file });
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(buildHlsTrackPlaylist(audio.track, baseUrl ?? "", session.mode, "audio"));
      return;
    }
    res.writeHead(404).end("hls_not_found");
  }

  private async handleStreamRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("method_not_allowed");
      return;
    }
    if (!this.token) {
      res.writeHead(401).end("token_missing");
      return;
    }
    const streamId = decodeURIComponent(url.pathname.replace("/playback/stream/", ""));
    if (!streamId) {
      res.writeHead(400).end("stream_missing");
      return;
    }
    this.pruneStreams();
    const stream = this.streams.get(streamId);
    if (!stream || isExpiredRelease(stream, Date.now())) {
      if (stream && isExpiredRelease(stream, Date.now())) {
        this.streams.delete(streamId);
      }
      if (shouldDebugPlayback()) {
        logger.warn({
          streamId,
          active: this.streams.size,
          released: stream?.releasedAt ?? null,
        }, "stream missing");
      }
      res.writeHead(404).end("stream_not_found");
      return;
    }
    if (shouldDebugPlayback()) {
      logger.info({ streamId, range: req.headers.range ?? null }, "stream request");
    }
    const totalSize = stream.totalSize;
    const { start, end, isRange, invalid } = parseRangeHeader(req.headers.range, totalSize);
    if (invalid) {
      res.writeHead(416).end("range_invalid");
      return;
    }
    const cap = resolveRangeCap();
    const forceCap = shouldForceRangeCap();
    let rangeStart = start;
    let rangeEnd = end;
    let forcedRange = false;
    if (forceCap && !isRange) {
      rangeStart = 0;
      rangeEnd = Math.min(totalSize - 1, cap - 1);
      forcedRange = true;
    } else if (forceCap && rangeEnd - rangeStart + 1 > cap) {
      rangeEnd = Math.min(totalSize - 1, rangeStart + cap - 1);
      forcedRange = true;
    }
    if (forcedRange) {
      logPlayback("stream.range.capped", {
        streamId,
        range: `${rangeStart}-${rangeEnd}`,
        cap,
      });
    }
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      "Content-Type": stream.contentType,
    };
    const isRangeResponse = isRange || forcedRange;
    const contentLength = isRangeResponse
      ? computeRangeLength(stream.segments, rangeStart, rangeEnd)
      : totalSize;
    if (contentLength <= 0) {
      res.writeHead(416).end("range_empty");
      return;
    }
    headers["Content-Length"] = String(contentLength);
    if (isRangeResponse) {
      headers["Content-Range"] = `bytes ${rangeStart}-${rangeEnd}/${totalSize}`;
      res.writeHead(206, headers);
    } else {
      res.writeHead(200, headers);
    }
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    this.throttle.wrap(res);
    try {
      await this.streamRange(stream, rangeStart, rangeEnd, req, res);
      if (!res.writableEnded) {
        res.end();
      }
    } catch (error) {
      if (isClientDisconnect(req, res, error)) {
        return;
      }
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : "stream_failed";
        res.writeHead(playbackFailureStatus(error)).end(message);
      } else {
        res.destroy();
      }
    }
  }

  private async streamRange(
    stream: PlaybackStream,
    start: number,
    end: number,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const segments = stream.segments.filter((segment) => segment.end >= start && segment.start <= end);
    const localOnly = shouldUseLocalObjects();
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (req.aborted || res.destroyed) return;
      const rangeStart = Math.max(0, start - segment.start);
      const rangeEnd = Math.min(segment.size - 1, end - segment.start);
      if (rangeEnd < rangeStart) continue;
      if (localOnly) {
        const localObjectsDir = resolveLocalObjectsDir();
        const localPath = joinPath(localObjectsDir, segment.key);
        if (existsSync(localPath)) {
          const raw = await fs.readFile(localPath);
          const payload = isEncryptedPayload(raw) ? (await decryptMediaObject(raw)).plaintext : raw;
          if (req.aborted || res.destroyed || !res.writable) return;
          if (!res.write(payload.subarray(rangeStart, rangeEnd + 1))) {
            await once(res, "drain");
            if (req.aborted || res.destroyed || !res.writable) return;
          }
          continue;
        }
        throw new Error("local_object_missing");
      }
      const payload = await this.getObjectPayload(segment.key, this.burstTracker.note(this.hlsKeyIndex.get(segment.key)));
      if (req.aborted || res.destroyed || !res.writable) return;
      if (!res.write(payload.subarray(rangeStart, rangeEnd + 1))) {
        await once(res, "drain");
        if (req.aborted || res.destroyed || !res.writable) return;
      }
    }
  }

  private pruneStreams() {
    const now = Date.now();
    for (const [id, stream] of this.streams.entries()) {
      if (isExpiredRelease(stream, now)) {
        this.streams.delete(id);
      }
    }
  }

  /** Gateway scheduler hints (STOR-BW-01): the playing variant's bitrate, `burst` on a start/seek foreground fetch, and the silo report. */
  private buildDownloadHints(key: string, burst: Burst | undefined): StorageDownloadHints {
    const bitrateBps = this.hlsKeyIndex.get(key)?.bitrateBps;
    const onTraffic = this.hooks?.onPlaybackTraffic;
    return {
      ...(bitrateBps ? { playbackBps: bitrateBps } : {}),
      ...(burst ? { burst } : {}),
      ...(onTraffic ? { onTraffic } : {}),
    };
  }

  private async fetchObjectViaTunnel(key: string, burst?: Burst): Promise<Buffer> {
    if (!this.token) throw new Error("token_missing");
    // STOR-BW-11: every playback names the profile picked at "Who's watching?" (the main profile's id included); none is never guessed.
    const profileId = getActivePlaybackProfileId();
    if (!profileId) {
      logPlayback("object.fetch.profile_required", { key });
      this.hooks?.onPlaybackProfileRefused?.(PLAYBACK_PROFILE_REQUIRED_CODE);
      throw new StorageTunnelError(400, { error: PLAYBACK_PROFILE_REQUIRED_CODE });
    }
    const attempts = resolveObjectFetchRetryAttempts();
    const baseDelayMs = resolveObjectFetchRetryDelayMs();
    // Upstream link measurement (#25): video media segments only, per attempt.
    const metered = isMeteredHlsObject(this.hlsKeyIndex.get(key));
    return await runWithRetries(
      async (attempt) => {
        this.signedUrlMetrics.requests += 1;
        this.hooks?.onSignedUrlRequest?.(1);
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        const linkFetch = metered ? this.linkMeter.begin() : null;
        try {
          await downloadStorageObjectViaTunnelToSink(
            this.token as string,
            key,
            async (chunk) => {
              const part = Buffer.from(chunk);
              chunks.push(part);
              totalBytes += part.length;
              linkFetch?.addBytes(part.length);
            },
            {
              clientType: "desktop",
              clientVersion: "desktop-playback",
              purpose: "playback",
              profileId,
              hints: this.buildDownloadHints(key, burst),
            }
          );
        } catch (error) {
          linkFetch?.end("failed");
          if (isSubscriptionUnpaidError(error)) {
            logPlayback("object.fetch.subscription_unpaid", { key, wipeAt: readSubscriptionUnpaidWipeAt(error) });
            throw error;
          }
          if (isPlaybackProfileError(error)) {
            logPlayback("object.fetch.profile_refused", { key, profileId, error: error.code });
            this.hooks?.onPlaybackProfileRefused?.(error.code);
            throw error;
          }
          if (isFreePlaybackRefusedError(error)) {
            logPlayback("object.fetch.free_playback_refused", { key });
            this.hooks?.onPlaybackRefused?.(storageTrafficFromError(error));
            throw error;
          }
          if (isPlaybackStoppedError(error)) {
            logPlayback("object.fetch.playback_stopped", { key });
            this.hooks?.onPlaybackStopped?.(storageTrafficFromError(error));
            throw error;
          }
          const message = error instanceof Error ? error.message : "object_fetch_failed";
          if (attempt < attempts) {
            logPlayback("object.fetch.retry", { key, attempt, error: message });
          }
          throw error;
        }
        if (linkFetch) {
          const sampleBps = linkFetch.end("complete");
          logPlayback("link.meter.sample", { key, bytes: totalBytes, sampleBps, estimate: this.getLinkEstimate() });
        }
        if (attempt > 1) {
          logPlayback("object.fetch.recovered", { key, attempt, bytes: totalBytes });
        }
        return Buffer.concat(chunks, totalBytes);
      },
      {
        attempts,
        baseDelayMs,
        // 402 `subscription_unpaid`, 503 `free_playback_refused`, 503 `playback_stopped` and the profile refusals are final: retrying
        // only delays the user-facing message (#145, STOR-BW-07, STOR-BW-08, STOR-BW-11).
        shouldRetry: (error) =>
          !isSubscriptionUnpaidError(error) &&
          !isFreePlaybackRefusedError(error) &&
          !isPlaybackStoppedError(error) &&
          !isPlaybackProfileError(error),
      }
    );
  }

  private prefetchHlsObjects(key: string) {
    // The window follows the gateway's current traffic state: capped to its playbackBufferSeconds while
    // high, the full look-ahead again as soon as it is normal (STOR-BW-01).
    const nextKeys = limitPrefetchKeys(
      this.hlsObjectPrefetchKeys.get(key) ?? [],
      this.hooks?.getTraffic?.() ?? NORMAL_TRAFFIC,
      (nextKey) => this.hlsKeyIndex.get(nextKey)?.durationSeconds ?? null,
    );
    if (nextKeys.length === 0) return;
    if (shouldDebugPlaybackTimings()) {
      logPlayback("object.prefetch.scheduled", { key, nextKeys });
    }
    // The newest request wins: its window goes to the front, and queued keys of the same
    // session+track outside it are stale (e.g. left over from before a seek) and dropped.
    const requested = this.hlsKeyIndex.get(key);
    const fresh = nextKeys.filter(
      (nextKey) => !this.objectPayloadCache.has(nextKey) && !this.objectPayloadPending.has(nextKey)
    );
    const retained = this.hlsPrefetchQueue.filter((queued) => {
      if (fresh.includes(queued)) return false;
      const meta = this.hlsKeyIndex.get(queued);
      return !(requested && meta?.sessionId === requested.sessionId && meta.kind === requested.kind);
    });
    this.hlsPrefetchQueue = [...fresh, ...retained].slice(0, HLS_OBJECT_PREFETCH_QUEUE_MAX);
    this.drainHlsPrefetchQueue();
  }

  // Foreground object fetches call getObjectPayload directly and never wait on this queue.
  private drainHlsPrefetchQueue() {
    while (
      this.server &&
      this.hlsPrefetchInFlight < HLS_OBJECT_PREFETCH_MAX_IN_FLIGHT &&
      this.hlsPrefetchQueue.length > 0
    ) {
      const nextKey = this.hlsPrefetchQueue.shift() as string;
      // A foreground request may have cached or started this key while it waited in the queue.
      if (this.objectPayloadCache.has(nextKey) || this.objectPayloadPending.has(nextKey)) continue;
      this.hlsPrefetchInFlight += 1;
      this.getObjectPayload(nextKey)
        .catch(() => undefined)
        .finally(() => {
          this.hlsPrefetchInFlight -= 1;
          this.drainHlsPrefetchQueue();
        });
    }
  }

  private storeObjectPayload(key: string, payload: Buffer) {
    const existing = this.objectPayloadCache.get(key);
    if (existing) {
      this.objectPayloadCacheBytes -= existing.length;
      this.objectPayloadCache.delete(key);
    }
    this.objectPayloadCache.set(key, payload);
    this.objectPayloadCacheBytes += payload.length;
    const maxBytes = resolveObjectPayloadCacheMaxBytes();
    while (this.objectPayloadCacheBytes > maxBytes && this.objectPayloadCache.size > 0) {
      const oldestKey = this.objectPayloadCache.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.objectPayloadCache.get(oldestKey);
      this.objectPayloadCache.delete(oldestKey);
      if (oldest) {
        this.objectPayloadCacheBytes -= oldest.length;
      }
    }
  }

  private async getObjectPayload(key: string, burst?: Burst) {
    const epoch = this.objectPayloadEpoch;
    const cached = this.objectPayloadCache.get(key);
    if (cached) {
      this.objectPayloadCache.delete(key);
      this.objectPayloadCache.set(key, cached);
      if (shouldDebugPlaybackTimings()) {
        logPlayback("object.payload.cache_hit", { key, bytes: cached.length });
      }
      return cached;
    }
    const pending = this.objectPayloadPending.get(key);
    if (pending) {
      if (shouldDebugPlaybackTimings()) {
        logPlayback("object.payload.pending_wait", { key });
      }
      const payload = await pending;
      // The fetch may have been started by a playback that closed meanwhile: its creator skipped the
      // store (stale epoch), so a joiner from the current playback stores the bytes it waited for.
      if (epoch === this.objectPayloadEpoch && !this.objectPayloadCache.has(key)) {
        this.storeObjectPayload(key, payload);
      }
      return payload;
    }
    const promise = (async () => {
      const startMs = Date.now();
      const fetchStartMs = Date.now();
      const raw = (await this.readLocalPiece(key)) ?? (await this.fetchObjectViaTunnel(key, burst));
      const fetchMs = Date.now() - fetchStartMs;
      const decryptStartMs = Date.now();
      const encrypted = isEncryptedPayload(raw);
      // Read before decrypt: decryptMediaObject may transfer `raw` to its worker.
      const rawBytes = raw.length;
      const payload = encrypted ? (await decryptMediaObject(raw)).plaintext : raw;
      const decryptMs = Date.now() - decryptStartMs;
      const totalMs = Date.now() - startMs;
      if (epoch === this.objectPayloadEpoch) {
        this.storeObjectPayload(key, payload);
      } else {
        logPlayback("object.payload.store_skipped_after_close", { key, bytes: payload.length });
      }
      if (shouldDebugPlaybackTimings()) {
        logPlayback("object.payload.fetched", {
          key,
          fetchMs,
          decryptMs,
          totalMs,
          encrypted,
          rawBytes,
          payloadBytes: payload.length,
        });
      }
      return payload;
    })();
    this.objectPayloadPending.set(key, promise);
    try {
      return await promise;
    } finally {
      this.objectPayloadPending.delete(key);
    }
  }

  /** The sealed bytes of a piece saved offline on this device, or null (not saved here / gone: fall back to the tunnel). */
  private async readLocalPiece(key: string): Promise<Buffer | null> {
    const path = this.localPieces.get(key);
    if (!path) return null;
    try {
      const raw = await fs.readFile(path);
      logPlayback("object.local_piece", { key, bytes: raw.length });
      return raw;
    } catch (error) {
      logPlayback("object.local_piece_missing", {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      this.localPieces.delete(key);
      return null;
    }
  }
}
