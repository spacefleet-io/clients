/**
 * HLS playlist building for the integration routes.
 * Ported from apps/badger/desktop/src/main/playbackServer.ts (buildHlsExtinfDurations,
 * buildHlsTrackPlaylist, buildMasterPlaylist) so both stay byte-compatible for players.
 */

/** Seconds every video segment boundary is announced earlier than its first frame (see desktop P10 note). */
export const HLS_VIDEO_SEEK_LEAD_SECONDS = 0.25;

export type HlsSegment = { key: string; durationSeconds: number };

export type HlsTrack = {
  initKey: string;
  codecString: string | null;
  segments: HlsSegment[];
};

export type HlsVideoVariant = {
  id: string;
  quality: string;
  bitrateKbps: number | null;
  width: number | null;
  height: number | null;
  track: HlsTrack;
};

export type HlsAudioVariant = {
  id: string;
  language: string;
  label: string;
  isDefault: boolean;
  track: HlsTrack;
};

export type HlsUnit = {
  videos: HlsVideoVariant[];
  audio: HlsAudioVariant[];
};

export type ChunkLike = { key: string; sizeBytes: number | null; startSeconds: number | null };

/** Segment duration = next.start - start; last = duration - start; fallback duration / count. */
export const segmentsFromChunks = (chunks: readonly ChunkLike[], durationSeconds: number | null): HlsSegment[] => {
  const fallback = durationSeconds && chunks.length > 0 ? durationSeconds / chunks.length : 6;
  return chunks.map((chunk, index) => {
    const start = chunk.startSeconds;
    const nextStart = chunks[index + 1]?.startSeconds;
    let duration = fallback;
    if (typeof start === "number" && typeof nextStart === "number" && nextStart > start) {
      duration = nextStart - start;
    } else if (
      typeof start === "number" &&
      index === chunks.length - 1 &&
      durationSeconds &&
      durationSeconds > start
    ) {
      duration = durationSeconds - start;
    }
    return { key: chunk.key, durationSeconds: Math.max(0.001, duration) };
  });
};

/**
 * EXTINF values for a track. Boundaries are accumulated in full precision and rounded to ms before
 * differencing; boundaries after the first are moved `leadSeconds` earlier, the final end is not.
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

// The ".m4s" suffix is cosmetic: ffmpeg's HLS demuxer (used by Jellyfin) refuses extensionless segment URLs.
export const OBJECT_URL_SUFFIX = ".m4s";
export const objectUrl = (baseUrl: string, key: string) => `${baseUrl}/integration/v1/object/${encodeURIComponent(key)}${OBJECT_URL_SUFFIX}`;

export const buildTrackPlaylist = (track: HlsTrack, baseUrl: string, kind: "video" | "audio") => {
  const durations = buildHlsExtinfDurations(
    track.segments.map((segment) => segment.durationSeconds),
    kind === "video" ? HLS_VIDEO_SEEK_LEAD_SECONDS : 0
  );
  const targetDuration = durations.length > 0 ? Math.max(...durations) : 1;
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(targetDuration))}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-MAP:URI="${objectUrl(baseUrl, track.initKey)}"`,
  ];
  track.segments.forEach((segment, index) => {
    lines.push(`#EXTINF:${durations[index].toFixed(3)},`);
    lines.push(objectUrl(baseUrl, segment.key));
  });
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
};

/**
 * Master playlist. `unitBase` is `<origin>/integration/v1/media/<mediaId>[/<episodeId>]/<qualityKey>` so
 * variant URLs stay under the same route. `preferredAudioId` marks the DEFAULT rendition.
 */
export const buildMasterPlaylist = (unit: HlsUnit, unitBase: string, preferredAudioId?: string | null) => {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  const audio = unit.audio;
  const primaryAudio =
    audio.find((entry) => entry.id === preferredAudioId) ?? audio.find((entry) => entry.isDefault) ?? audio[0] ?? null;
  const labelCounts = new Map<string, number>();
  audio.forEach((entry) => {
    const key = (entry.label ?? "").trim().toLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  });
  const seen = new Map<string, number>();
  audio.forEach((entry) => {
    const baseLabel = (entry.label ?? "").trim() || "Audio";
    const key = baseLabel.toLowerCase();
    const seenCount = (seen.get(key) ?? 0) + 1;
    seen.set(key, seenCount);
    const displayLabel = (labelCounts.get(key) ?? 0) > 1 ? `${baseLabel} ${seenCount}` : baseLabel;
    const attrs = [
      "TYPE=AUDIO",
      'GROUP-ID="audio"',
      `NAME="${displayLabel.replace(/"/g, '\\"')}"`,
      ...(entry.language && entry.language !== "und" ? [`LANGUAGE="${entry.language.replace(/"/g, "")}"`] : []),
      `DEFAULT=${entry.id === primaryAudio?.id ? "YES" : "NO"}`,
      "AUTOSELECT=YES",
      `URI="${unitBase}/audio-${entry.id}.m3u8"`,
    ];
    lines.push(`#EXT-X-MEDIA:${attrs.join(",")}`);
  });
  unit.videos.forEach((video) => {
    const codecs = [video.track.codecString, primaryAudio?.track.codecString].filter(Boolean).join(",");
    const bandwidth = Math.max(1, (video.bitrateKbps ?? 5000) * 1000);
    const resolution = video.width && video.height ? `,RESOLUTION=${video.width}x${video.height}` : "";
    const audioAttr = audio.length > 0 ? ',AUDIO="audio"' : "";
    const codecAttr = codecs ? `,CODECS="${codecs}"` : "";
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${codecAttr}${audioAttr}${resolution}`);
    lines.push(`${unitBase}/video-${video.id}.m3u8`);
  });
  return `${lines.join("\n")}\n`;
};

/** Typical 16:9 resolution for a quality label like "1080p" / "2160p" / "4k". */
export const resolutionForQuality = (quality: string): { width: number; height: number } | null => {
  const match = /^(\d{3,4})p$/i.exec(quality.trim());
  const height = match ? Number(match[1]) : /^4k$/i.test(quality.trim()) ? 2160 : null;
  if (!height) return null;
  return { width: Math.round((height * 16) / 9 / 2) * 2, height };
};
